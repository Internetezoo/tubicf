AddEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

// Configuration options
const config = {
  // Support multiple domains, you should modifiy this if you wish to deploy it to your own Cloudflare Worker.
  proxyDomains: ['tubicf.internetezoo.workers.dev'], // <--- MÓDOSÍTVA ERRE A DOMAINRE
  separator: '------', // Delimiter between worker path and real target URL
  homepage: true, // Whether to enable the homepage
  allowedDomains: [], // Domain whitelist, set to [] to allow all

  
  // Browser emulation settings
  browserEmulation: {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
    acceptLanguage: 'en-US,en;q=0.9',
    acceptEncoding: 'gzip, deflate, br',
    connection: 'keep-alive',
    upgradeInsecureRequests: '1',
    secFetchDest: 'document',
    secFetchMode: 'navigate',
    secFetchSite: 'none',
    secFetchUser: '?1',
  },
  fallback: {
    enabled: true,
    autoReload: true,
  },
  specialSites: {
    wikipedia: {
      enabled: true,
      domains: ['wikipedia.org', 'wikimedia.org', 'mediawiki.org']
    }
  }
}

async function handleRequest(request) {
  const url = new URL(request.url)
  
  // Check if the current domain is one of our proxy domains
  const isProxyHost = config.proxyDomains.includes(url.host)
  
  // If the request is for the proxy root
  if (isProxyHost && url.pathname === '/') {
    // a) When no query-string is present we treat it as a genuine homepage request
    if (config.homepage && !url.search) {
      return getHomePage()
    }

    /*
      b) When a query-string exists (e.g. "/?q=search" coming from a proxied
      site like DuckDuckGo) we attempt to determine the intended target by
      inspecting the Referer header, which still contains the full proxied
      URL including the original host. Using that information we rebuild the
      real destination so the request will be forwarded correctly instead of
      falling back to the homepage.
    */
    if (url.search) {
      const ref = request.headers.get('Referer') || ''
      try {
        const refURL = new URL(ref)
        const rawPath = refURL.pathname.substring(1)
        const sep = config.separator
        let path = rawPath
        if (rawPath.startsWith(sep)) {
          path = rawPath.substring(sep.length)
        }
        const inner = path
        if (inner.startsWith('http://') || inner.startsWith('https://')) {
          const base = new URL(inner)
          const targetStr = `${base.origin}${url.search}` // e.g. https://duckduckgo.com/?q=foo
          url.pathname = '/' + config.separator + targetStr
        }
      } catch (_) {
        /* ignore – fallback handled later */
      }
    }
  }

  let targetURL
  
  try {
    // Determine target URL
    if (isProxyHost) {
      // Extract target URL from path
      if (url.pathname === '/proxy' && url.searchParams.has('url')) {
        // Handle /proxy?url=https://example.com format
        const urlParam = url.searchParams.get('url')
        targetURL = new URL(urlParam)
      } else if (url.pathname.startsWith('/')) {
        // Handle /------https://example.com format
        const rawPath = url.pathname.substring(1)
        const sep = config.separator
        let path = rawPath
        if (rawPath.startsWith(sep)) {
          path = rawPath.substring(sep.length)
        }
        if (path.startsWith('http://') || path.startsWith('https://')) {
          targetURL = new URL(path)
        } else if (path) {
          /*
            Handle relative paths such as "/i.js" or "/next/page" that
            originate from within the currently proxied site.  We first try to
            reconstruct the full base URL from the Referer header (if present)
            so we can resolve the relative path accurately.
          */
          let resolved = null
          const ref = request.headers.get('Referer') || ''
          if (ref.startsWith(`https://${url.host}/`)) {
            let refInner = ref.substring(`https://${url.host}/`.length)
            if (refInner.startsWith(config.separator)) refInner = refInner.substring(config.separator.length)
            if (refInner.startsWith('http://') || refInner.startsWith('https://')) {
              try {
                const baseRefURL = new URL(refInner)
                resolved = new URL(path, baseRefURL) // relative resolution
              } catch {}
            }
          }
          if (resolved) {
            targetURL = resolved
          } else {
            // Try to rebuild using Referer (root-relative request like "/?q=...")
            let rebuilt = null
            const ref = request.headers.get('Referer') || ''
            if (ref.startsWith(`https://${url.host}/`)) {
              let refInner = ref.substring(`https://${url.host}/`.length)
              if (refInner.startsWith(config.separator)) refInner = refInner.substring(config.separator.length)
              if (refInner.startsWith('http://') || refInner.startsWith('https://')) {
                try {
                  const baseOrigin = new URL(refInner).origin
                  const rebuiltStr = `${baseOrigin}/${url.search.startsWith('?') ? url.search.substring(1) : url.search}`
                  rebuilt = new URL(rebuiltStr)
                } catch {}
              }
            }
            
            if (rebuilt) {
              targetURL = rebuilt
              // No need to modify pathname further
            } else if (!path.includes('.') && url.search === '') {
              // This is a plain keyword with no search string
              targetURL = new URL('https://duckduckgo.com/?q=' + encodeURIComponent(path))
            } else if (!path.includes('.')) {
              // Plain keyword + existing search parameters appended to keyword search
              const q = encodeURIComponent(path)
              const ddg = new URL('https://duckduckgo.com/?q=' + q + '&' + url.search.substring(1))
              targetURL = ddg
            } else if (url.searchParams.has('q')) {
              // Fallback to DuckDuckGo search when 'q' parameter present
              const ddgURL = new URL('https://duckduckgo.com/')
              url.searchParams.forEach((value, key) => ddgURL.searchParams.append(key, value))
              targetURL = ddgURL
            } else {
              // Treat as domain with implied https
              try {
                targetURL = new URL('https://' + path)
              } catch {
                return new Response('Invalid URL request', { status: 400 })
              }
            }
          }
        } else {
          /*
            Empty path but we might still have a query-string. Many sites such as
            DuckDuckGo use root-relative URLs like "https://duckduckgo.com/?q=foo".
            When a proxied page generates such a link we will receive a request
            for "/?q=foo". If this happens – and there is no Referer we can use
            to restore the full URL (handled earlier) – we treat it as a DuckDuckGo
            search request by default so users aren't thrown back to an error page.
          */
          if (url.searchParams.has('q')) {
            // Preserve all parameters so that bangs etc. keep working
            const ddgURL = new URL('https://duckduckgo.com/')
            url.searchParams.forEach((value, key) => ddgURL.searchParams.append(key, value))
            targetURL = ddgURL
          } else {
            // Empty path with no query – invalid usage
            return new Response('Invalid URL request', { status: 400 })
          }
        }
      }
    } else {
      // Use request URL directly
      targetURL = url
    }
    
    // Check domain whitelist
    if (config.allowedDomains.length > 0) {
      const isAllowed = config.allowedDomains.some(domain => 
        targetURL.hostname === domain || targetURL.hostname.endsWith(`.${domain}`)
      )
      if (!isAllowed) {
        return new Response('Domain not in whitelist', { status: 403 })
      }
    }
  } catch (error) {
    return new Response(`URL parsing error: ${error.message}`, { 
      status: 400, 
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' }
    })
  }

  // Check if this is a Wikipedia/Wikimedia site
  const isWikipediaSite = config.specialSites.wikipedia.enabled && 
    config.specialSites.wikipedia.domains.some(domain => 
      targetURL.hostname.endsWith(domain));

  // Prepare request headers to emulate a real browser
  let newHeaders = new Headers()
  
  // Copy select headers from the original request
  const headersToKeep = [
    'cookie', 
    'range',
    'if-none-match',
    'if-modified-since',
    'content-type',
    'content-length'
  ]
  
  headersToKeep.forEach(header => {
    if (request.headers.has(header)) {
      newHeaders.set(header, request.headers.get(header))
    }
  })

  // Add browser emulation headers
  newHeaders.set('User-Agent', config.browserEmulation.userAgent)
  newHeaders.set('Accept', config.browserEmulation.accept)
  newHeaders.set('Accept-Language', config.browserEmulation.acceptLanguage)
  newHeaders.set('Accept-Encoding', config.browserEmulation.acceptEncoding)
  newHeaders.set('Connection', config.browserEmulation.connection)
  newHeaders.set('Upgrade-Insecure-Requests', config.browserEmulation.upgradeInsecureRequests)
  newHeaders.set('Sec-Fetch-Dest', config.browserEmulation.secFetchDest)
  newHeaders.set('Sec-Fetch-Mode', config.browserEmulation.secFetchMode)
  newHeaders.set('Sec-Fetch-Site', config.browserEmulation.secFetchSite)
  newHeaders.set('Sec-Fetch-User', config.browserEmulation.secFetchUser)
  
  
  // 🇺🇸 RÉGIÓ FELÜLÍRÁSA 🇺🇸
  // Beállítjuk a 'CF-IPCountry' fejlécet 'US' értékre, hogy a céloldal azt higgye, a kérés az USA-ból érkezik.
  const desiredCountryCode = 'US'; 
  newHeaders.set('CF-IPCountry', desiredCountryCode); 
  // -------------------------

  
  // Essential headers for the target site
  newHeaders.set('Host', targetURL.host)
  newHeaders.set('Origin', targetURL.origin)
  newHeaders.set('Referer', targetURL.href)
  
  // Check if this is XHR/fetch request from the browser
  const isXHR = request.headers.get('X-Requested-With') === 'XMLHttpRequest' || 
                request.headers.get('Accept')?.includes('application/json');
  
  if (isXHR) {
    newHeaders.set('X-Requested-With', 'XMLHttpRequest')
  }

  // Create new request
  let newRequest = new Request(targetURL, {
    method: request.method,
    headers: newHeaders,
    body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : null,
    redirect: 'manual', // Handle redirects manually
  })

  try {
    // Send request to target server
    let response = await fetch(newRequest)
    
    // Handle redirects
    let newRespHeaders = new Headers(response.headers)
    if (response.status === 301 || response.status === 302 || response.status === 307 || response.status === 308) {
      const location = newRespHeaders.get('Location')
      if (location) {
        try {
          // Handle absolute and relative URLs
          const redirectURL = new URL(location, targetURL)
          // Build new proxy URL, using current accessed domain and custom separator
          const currentProxyDomain = url.host
          const newLocation = `https://${currentProxyDomain}/${config.separator}${redirectURL.href}`
          newRespHeaders.set('Location', newLocation)
        } catch (error) {
          console.error('Redirect URL processing error:', error)
        }
      }
    }
    
    // Copy all response cookies
    const setCookieHeaders = response.headers.getAll ? response.headers.getAll('Set-Cookie') : null
    if (setCookieHeaders) {
      // Multiple cookie support for browsers
      setCookieHeaders.forEach(cookie => {
        newRespHeaders.append('Set-Cookie', cookie)
      })
    }
    
    // Modify CORS related headers
    newRespHeaders.delete('Content-Security-Policy')
    newRespHeaders.delete('Content-Security-Policy-Report-Only')
    newRespHeaders.delete('X-Frame-Options') // Allow framing
    newRespHeaders.delete('X-Content-Type-Options') // Remove nosniff
    newRespHeaders.set('Access-Control-Allow-Origin', '*')
    newRespHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH')
    newRespHeaders.set('Access-Control-Allow-Headers', '*')
    newRespHeaders.set('Access-Control-Allow-Credentials', 'true')
    
    // Create new response object
    let newResponse = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newRespHeaders
    })
    
    // Get content type
    const contentType = newRespHeaders.get('Content-Type') || ''
    
    // Rewrite links in HTML content
    if (contentType.includes('text/html') || contentType.includes('application/xhtml+xml')) {
      // Use current accessed domain as proxy domain
      const currentProxyDomain = url.host
      
      let rewriter = new HTMLRewriter()
        .on('a[href]', new LinkRewriter(targetURL, 'href', currentProxyDomain))
        .on('form[action]', new LinkRewriter(targetURL, 'action', currentProxyDomain))
        .on('img[src]', new LinkRewriter(targetURL, 'src', currentProxyDomain))
        .on('img[srcset]', new SrcsetRewriter(targetURL, currentProxyDomain))
        .on('source[srcset]', new SrcsetRewriter(targetURL, currentProxyDomain))
        .on('link[href]', new LinkRewriter(targetURL, 'href', currentProxyDomain))
        .on('script[src]', new LinkRewriter(targetURL, 'src', currentProxyDomain))
        .on('iframe[src]', new LinkRewriter(targetURL, 'src', currentProxyDomain))
        .on('source[src]', new LinkRewriter(targetURL, 'src', currentProxyDomain))
        .on('video[src]', new LinkRewriter(targetURL, 'src', currentProxyDomain))
        .on('audio[src]', new LinkRewriter(targetURL, 'src', currentProxyDomain))
        .on('embed[src]', new LinkRewriter(targetURL, 'src', currentProxyDomain))
        .on('object[data]', new LinkRewriter(targetURL, 'data', currentProxyDomain))
        .on('track[src]', new LinkRewriter(targetURL, 'src', currentProxyDomain))
        .on('meta[content]', new MetaContentRewriter(targetURL, currentProxyDomain))
      
      // Handle base tag
      rewriter = rewriter.on('base[href]', new BaseTagRewriter(targetURL, currentProxyDomain))
      
      // Handle inline styles and attributes with URLs
      rewriter = rewriter.on('*[style]', new StyleAttributeRewriter(targetURL, currentProxyDomain))
      
      // Add Wikipedia specific handlers if needed
      if (isWikipediaSite) {
        // Wikipedia uses data-src for lazy loading
        rewriter = rewriter.on('img[data-src]', new LinkRewriter(targetURL, 'data-src', currentProxyDomain))
        // Handle Wikipedia's specific style elements
        rewriter = rewriter.on('style', new StyleElementRewriter(targetURL, currentProxyDomain))
      }
      
      // Inject scripts for fallback mechanism if enabled
      if (config.fallback.enabled && config.fallback.autoReload) {
        rewriter = rewriter.on('head', new HeadRewriter(targetURL.href))
      }
      
      newResponse = rewriter.transform(newResponse)
    }
    // Handle CSS content separately to rewrite URLs
    else if (contentType.includes('text/css') || contentType.includes('application/x-stylesheet')) {
      const currentProxyDomain = url.host
      const cssText = await response.text()
      const rewrittenCSS = rewriteCSS(cssText, targetURL, currentProxyDomain)
      
      newResponse = new Response(rewrittenCSS, {
        status: response.status,
        statusText: response.statusText,
        headers: newRespHeaders
      })
    }
    // Handle JavaScript to rewrite URLs directly embedded in code
    else if (contentType.includes('application/javascript') || contentType.includes('text/javascript')) {
      const currentProxyDomain = url.host
      const jsText = await response.text()
      
      // Very simplified JS URL rewriting - this could be enhanced
      const rewrittenJS = rewriteJavaScript(jsText, targetURL, currentProxyDomain)
      
      newResponse = new Response(rewrittenJS, {
        status: response.status,
        statusText: response.statusText,
        headers: newRespHeaders
      })
    }
    
    return newResponse
  } catch (error) {
    return new Response(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Proxy Error</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 800px;
            margin: 0 auto;
            padding: 20px;
          }
          .error-container {
            background-color: #f8d7da;
            color: #721c24;
            padding: 15px;
            border-radius: 4px;
            margin-bottom: 20px;
          }
          .direct-access {
            background-color: #d4edda;
            color: #155724;
            padding: 15px;
            border-radius: 4px;
            margin-bottom: 20px;
          }
          h1 { color: #d63031; }
          a.direct-link {
            display: inline-block;
            margin-top: 10px;
            color: #fff;
            background-color: #17a2b8;
            padding: 8px 16px;
            text-decoration: none;
            border-radius: 4px;
          }
          a.direct-link:hover {
            background-color: #138496;
          }
          .details {
            background-color: #f8f9fa;
            padding: 15px;
            border-radius: 4px;
            margin-top: 20px;
            font-family: monospace;
            white-space: pre-wrap;
          }
        </style>
      </head>
      <body>
        <h1>Proxy Request Failed</h1>
        <div class="error-container">
          <strong>Error:</strong> ${error.message}
        </div>
        
        <div class="direct-access">
          <p>The proxy couldn't reach the requested resource. You can try to access it directly:</p>
          <a class="direct-link" href="${targetURL.href}" target="_blank">Open ${targetURL.href} directly</a>
        </div>
        
        <div class="details">
          Request URL: ${targetURL.href}
          Time: ${new Date().toISOString()}
        </div>
      </body>
      </html>
    `, {
      status: 500,
      headers: {
        'Content-Type': 'text/html;charset=UTF-8',
        'Access-Control-Allow-Origin': '*'
      }
    })
  }
}

// Unified link rewrite handling with better URL handling
class LinkRewriter {
  constructor(baseURL, attributeName, proxyDomain) {
    this.baseURL = baseURL
    this.attributeName = attributeName
    this.proxyDomain = proxyDomain
  }
  
  element(element) {
    const attributeValue = element.getAttribute(this.attributeName)
    if (!attributeValue || attributeValue.startsWith('data:') || attributeValue.startsWith('javascript:')) return
    
    // Don't modify already proxied URLs
    if (attributeValue.startsWith(`https://${this.proxyDomain}/`)) return
    
    try {
      // Handle special URL cases for files, media, etc.
      let normalizedValue = attributeValue.trim()
      if (normalizedValue.startsWith('//')) {
        // Protocol-relative URL
        normalizedValue = this.baseURL.protocol + normalizedValue
      }
      
      // Build complete URL (handle relative paths)
      const absoluteURL = new URL(normalizedValue, this.baseURL)
      
      // Add onerror fallback for images
      if (this.attributeName === 'src' && element.tagName === 'img') {
        const originalSrc = absoluteURL.href
        element.setAtt
 }
  })
}
