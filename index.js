// A kimenő IP ellenőrző API
const IP_CHECK_API = 'https://ipinfo.io/json';

// USA Adatközpontok listája, amiket végigpróbálunk a legjobb eredmény érdekében
const US_COLOS_TO_TRY = ['IAD', 'DFW', 'LAX', 'SJC', 'EWR'];

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

// Configuration options
const config = {
  proxyDomains: ['tubicf.internetezoo.workers.dev'],
  separator: '', // Tiszta URL formátumhoz: /https://...
  homepage: true, 
  allowedDomains: [], 

  // Browser emulation settings
  browserEmulation: {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image:apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
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

/**
 * Lekéri a Worker kimenő IP-címét és GEO információját a megadott Colo beállítással.
 */
async function getEgressIP(colo) {
  try {
    const ipRequest = new Request(IP_CHECK_API, {
      method: 'GET',
      headers: { 'User-Agent': 'Cloudflare-Worker-IP-Check' },
      cf: { colo: colo } 
    });
    
    const response = await fetch(ipRequest);
    const data = await response.json();
    
    return {
      ip: data.ip || 'N/A',
      city: data.city || 'N/A',
      country: data.country || 'N/A',
      coloUsed: colo
    };
  } catch (e) {
    return { ip: 'API Error', city: 'N/A', country: 'N/A', coloUsed: colo };
  }
}

/**
 * Megpróbál USA IP-címet találni a megadott listán belső teszt hívásokkal.
 */
async function getBestEgressColo() {
    let bestGeoData = null;
    let finalColo = US_COLOS_TO_TRY[0];

    for (const colo of US_COLOS_TO_TRY) {
        const geoData = await getEgressIP(colo);
        
        if (geoData.country === 'US') {
            bestGeoData = geoData;
            finalColo = colo;
            break; // Sikeres USA IP esetén azonnal leáll
        }
    }
    
    if (!bestGeoData) {
        // Ha egyetlen USA IP-t sem talált, az első Colo teszteredményét használjuk a kijelzéshez,
        // de az utolsó próbát használjuk a fetch-hez.
        bestGeoData = await getEgressIP(US_COLOS_TO_TRY[US_COLOS_TO_TRY.length - 1]);
        finalColo = US_COLOS_TO_TRY[US_COLOS_TO_TRY.length - 1];
    }
    
    // Frissítjük a coloUsed mezőt, hogy tükrözze, melyik colot fogjuk használni a fetch-hez
    bestGeoData.coloUsed = finalColo;
    
    return { egressGeoData: bestGeoData, finalColo: finalColo };
}


async function handleRequest(request) {
  const url = new URL(request.url)
  const isProxyHost = config.proxyDomains.includes(url.host)
  
  // 1. Megkeressük a legjobb/kikényszeríthető USA Colot
  const { egressGeoData, finalColo } = await getBestEgressColo();
  
  const ingressGeoCountry = request.cf.country || 'N/A';
  
  // IP infó HTML blokk létrehozása
  const ipInfoHtml = `
    <div style="background-color: #f0f8ff; border: 1px solid #dcdcdc; padding: 10px; margin-bottom: 15px; border-radius: 4px; font-size: 14px; text-align: left;">
        <h4 style="margin: 0 0 5px 0; color: #333;">Cloudflare Proxy Infó 🌐</h4>
        <ul style="list-style: none; padding: 0; margin: 0;">
            <li><strong>Bejövő (Ön ➡️ Worker) Régió:</strong> ${request.cf.colo} (${ingressGeoCountry})</li>
            <li><strong>Kimenő (Worker ➡️ Cél) IP:</strong> <span style="color: ${egressGeoData.country === 'US' ? 'green' : 'red'}; font-weight: bold;">${egressGeoData.ip}</span></li>
            <li><strong>Kimenő (Cél) Régió:</strong> ${egressGeoData.city}, ${egressGeoData.country} (Kikényszerített Colo: ${finalColo})</li>
        </ul>
        <p style="margin: 5px 0 0 0; font-style: italic; color: #555;">(A kód ${US_COLOS_TO_TRY.length} USA Colot próbált ki a legjobb USA IP eléréséhez. A ${finalColo} Colot használja a fő kéréshez.)</p>
    </div>
  `;
  
  
  // -- A fő URL kezelési logika innentől változatlan --
  if (isProxyHost && url.pathname === '/') {
    if (config.homepage && !url.search) {
      return getHomePage(ipInfoHtml)
    }

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
          const targetStr = `${base.origin}${url.search}`
          url.pathname = '/' + config.separator + targetStr
        }
      } catch (_) {}
    }
  }

  let targetURL
  
  try {
    // Determine target URL
    if (isProxyHost) {
      if (url.pathname === '/proxy' && url.searchParams.has('url')) {
        const urlParam = url.searchParams.get('url')
        targetURL = new URL(urlParam)
      } else if (url.pathname.startsWith('/')) {
        const rawPath = url.pathname.substring(1)
        const sep = config.separator
        let path = rawPath
        
        if (rawPath.startsWith(sep)) {
          path = rawPath.substring(sep.length)
        }
        
        if (path.startsWith('http://') || path.startsWith('https://')) {
          targetURL = new URL(path)
        } else if (path) {
          let resolved = null
          const ref = request.headers.get('Referer') || ''
          if (ref.startsWith(`https://${url.host}/`)) {
            let refInner = ref.substring(`https://${url.host}/`.length)
            if (refInner.startsWith(config.separator)) refInner = refInner.substring(config.separator.length)
            if (refInner.startsWith('http://') || refInner.startsWith('https://')) {
              try {
                const baseRefURL = new URL(refInner)
                resolved = new URL(path, baseRefURL)
              } catch {}
            }
          }
          if (resolved) {
            targetURL = resolved
          } else {
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
            } else if (!path.includes('.') && url.search === '') {
              targetURL = new URL('https://duckduckgo.com/?q=' + encodeURIComponent(path))
            } else if (!path.includes('.')) {
              const q = encodeURIComponent(path)
              const ddg = new URL('https://duckduckgo.com/?q=' + q + '&' + url.search.substring(1))
              targetURL = ddg
            } else if (url.searchParams.has('q')) {
              const ddgURL = new URL('https://duckduckgo.com/')
              url.searchParams.forEach((value, key) => ddgURL.searchParams.append(key, value))
              targetURL = ddgURL
            } else {
              try {
                targetURL = new URL('https://' + path)
              } catch {
                return new Response('Invalid URL request', { status: 400 })
              }
            }
          }
        } else {
          if (url.searchParams.has('q')) {
            const ddgURL = new URL('https://duckduckgo.com/')
            url.searchParams.forEach((value, key) => ddgURL.searchParams.append(key, value))
            targetURL = ddgURL
          } else {
            return new Response('Invalid URL request', { status: 400 })
          }
        }
      }
    } else {
      targetURL = url
    }
    
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

  // Prepare request headers
  let newHeaders = new Headers()
  
  const headersToKeep = [
    'cookie', 'range', 'if-none-match', 'if-modified-since',
    'content-type', 'content-length'
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
  
  
  // 🇺🇸 RÉGIÓ FELÜLÍRÁSA A CÉLOLDAL FELÉ 🇺🇸
  const desiredCountryCode = 'US'; 
  newHeaders.set('CF-IPCountry', desiredCountryCode); 

  
  // Essential headers for the target site
  newHeaders.set('Host', targetURL.host)
  newHeaders.set('Origin', targetURL.origin)
  newHeaders.set('Referer', targetURL.href)
  
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
    redirect: 'manual', 
    // 🟢 A legjobb talált (vagy kényszerített) Colot használjuk
    cf: {
      colo: finalColo 
    }
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
          const redirectURL = new URL(location, targetURL)
          const currentProxyDomain = url.host
          const newLocation = `https://${currentProxyDomain}/${config.separator}${redirectURL.href}`
          newRespHeaders.set('Location', newLocation)
        } catch (error) {
          console.error('Redirect URL processing error:', error)
        }
      }
    }
    
    // Cookie-k és CORS kezelése
    const setCookieHeaders = response.headers.getAll ? response.headers.getAll('Set-Cookie') : null
    if (setCookieHeaders) {
      setCookieHeaders.forEach(cookie => {
        newRespHeaders.append('Set-Cookie', cookie)
      })
    }
    
    newRespHeaders.delete('Content-Security-Policy')
    newRespHeaders.delete('Content-Security-Policy-Report-Only')
    newRespHeaders.delete('X-Frame-Options')
    newRespHeaders.delete('X-Content-Type-Options')
    newRespHeaders.set('Access-Control-Allow-Origin', '*')
    newRespHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH')
    newRespHeaders.set('Access-Control-Allow-Headers', '*')
    newRespHeaders.set('Access-Control-Allow-Credentials', 'true')
    
    let newResponse = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newRespHeaders
    })
    
    const contentType = newRespHeaders.get('Content-Type') || ''
    
    // Rewrite links in HTML content
    if (contentType.includes('text/html') || contentType.includes('application/xhtml+xml')) {
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
      
      if (isWikipediaSite) {
        rewriter = rewriter.on('img[data-src]', new LinkRewriter(targetURL, 'data-src', currentProxyDomain))
        rewriter = rewriter.on('style', new StyleElementRewriter(targetURL, currentProxyDomain))
      }
      
      // 🚨 FONTOS: IP Infó blokk beillesztése a head után
      rewriter = rewriter.on('body', new BodyRewriter(ipInfoHtml, targetURL.href));
      
      newResponse = rewriter.transform(newResponse)
    }
    // CSS tartalom átírása
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
    // JavaScript URL átírás
    else if (contentType.includes('application/javascript') || contentType.includes('text/javascript')) {
      const currentProxyDomain = url.host
      const jsText = await response.text()
      
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

// Rewriter class for inserting the IP info box at the top of the body
class BodyRewriter {
  constructor(ipInfoHtml, originalURL) {
    this.ipInfoHtml = ipInfoHtml;
    this.originalURL = originalURL;
  }
  
  element(element) {
    // Inject IP Info at the very beginning of the body
    element.prepend(this.ipInfoHtml, { html: true });

    // Inject scripts for fallback mechanism (if enabled)
    if (config.fallback.enabled && config.fallback.autoReload) {
      this.injectFallbackScripts(element);
    }
    
    element.onEndTag(endTag => {});
  }

  injectFallbackScripts(element) {
    element.append(`
      <script>
        // Add fallback mechanism for images and other resources that fail to load
        document.addEventListener('DOMContentLoaded', function() {
          const separator = '${config.separator}'; // Get separator for JS logic
          // Fallback for images
          document.querySelectorAll('img').forEach(img => {
            if (!img.hasAttribute('data-original-src')) {
              const originalSrc = new URL(img.src).pathname.slice(1);
              img.setAttribute('data-original-src', originalSrc);
              img.setAttribute('onerror', "this.onerror=null;if(this.src!==this.dataset.originalSrc){this.src=this.dataset.originalSrc;}");
            }
          });
          
          // Enhance behavior for links opening in new tabs
          document.querySelectorAll('a[target="_blank"]').forEach(link => {
            let originalUrl = link.href;
            if (originalUrl.includes(location.host)) {
              try {
                // Remove host part to get original proxy path
                const parts = new URL(originalUrl).pathname.substring(1).split(separator);
                originalUrl = parts.length > 1 ? parts.join(separator) : originalUrl;
              } catch(e) {}
            }
            
            link.addEventListener('click', function(e) {
              if (e.button !== 0 || e.ctrlKey || e.metaKey) return;
              e.preventDefault();
              link.setAttribute('rel', 'noreferrer noopener');
              window.open(link.href, '_blank');
            });
          });
          
          // Add Wikipedia specific fixes
          if (document.querySelector('body.mediawiki')) {
            document.querySelectorAll('img[data-src]').forEach(img => {
              if (!img.src && img.dataset.src) {
                img.src = img.dataset.src;
              }
            });
            document.querySelectorAll('[style*="background"]').forEach(el => {
              if (el.style.backgroundImage) {
                el.setAttribute('data-original-bg', el.style.backgroundImage);
              }
            });
          }
        });
      </script>
    `, {html: true});
  }
}

// -- A LinkRewriter és a segédfüggvények (CSS/JS rewrite) változatlanok --

class LinkRewriter {
  constructor(baseURL, attributeName, proxyDomain) {
    this.baseURL = baseURL
    this.attributeName = attributeName
    this.proxyDomain = proxyDomain
  }
  
  element(element) {
    const attributeValue = element.getAttribute(this.attributeName)
    if (!attributeValue || attributeValue.startsWith('data:') || attributeValue.startsWith('javascript:')) return
    
    if (attributeValue.startsWith(`https://${this.proxyDomain}/`)) return
    
    try {
      let normalizedValue = attributeValue.trim()
      if (normalizedValue.startsWith('//')) {
        normalizedValue = this.baseURL.protocol + normalizedValue
      }
      
      const absoluteURL = new URL(normalizedValue, this.baseURL)
      
      if (this.attributeName === 'src' && element.tagName === 'img') {
        const originalSrc = absoluteURL.href
        element.setAttribute('data-original-src', originalSrc)
        element.setAttribute('onerror', `this.onerror=null;if(this.src!==this.dataset.originalSrc){this.src=this.dataset.originalSrc;}`)
      }
      
      const newURL = `https://${this.proxyDomain}/${config.separator}${absoluteURL.href}`
      element.setAttribute(this.attributeName, newURL)
    } catch (e) {
      console.error(`URL rewrite error [${attributeValue}]:`, e)
    }
  }
}

class SrcsetRewriter {
  constructor(baseURL, proxyDomain) {
    this.baseURL = baseURL
    this.proxyDomain = proxyDomain
  }
  
  element(element) {
    const srcset = element.getAttribute('srcset')
    if (!srcset) return
    
    try {
      const srcsetParts = srcset.split(/,\s+/)
      const newSrcsetParts = srcsetParts.map(part => {
        const [url, size] = part.trim().split(/\s+/)
        if (!url) return part
        
        if (url.startsWith('data:')) return part
        if (url.startsWith(`https://${this.proxyDomain}/`)) return part
        
        try {
          let normalizedUrl = url
          if (normalizedUrl.startsWith('//')) {
            normalizedUrl = this.baseURL.protocol + normalizedUrl
          }
          
          const absoluteURL = new URL(normalizedUrl, this.baseURL)
          
          const newURL = `https://${this.proxyDomain}/${config.separator}${absoluteURL.href}`
          
          return size ? `${newURL} ${size}` : newURL
        } catch (e) {
          return part 
        }
      })
      
      element.setAttribute('srcset', newSrcsetParts.join(', '))
    } catch (e) {
      console.error(`Srcset rewrite error:`, e)
    }
  }
}

class MetaContentRewriter {
  constructor(baseURL, proxyDomain) {
    this.baseURL = baseURL
    this.proxyDomain = proxyDomain
  }
  
  element(element) {
    const httpEquiv = element.getAttribute('http-equiv')
    const content = element.getAttribute('content')
    
    if (httpEquiv && httpEquiv.toLowerCase() === 'refresh' && content) {
      const parts = content.split(';url=')
      if (parts.length === 2) {
        try {
          const url = new URL(parts[1], this.baseURL)
          const newURL = `https://${this.proxyDomain}/${config.separator}${url.href}`
          element.setAttribute('content', `${parts[0]};url=${newURL}`)
        } catch (e) {
          console.error(`Meta refresh URL rewrite error:`, e)
        }
      }
    }
    
    const property = element.getAttribute('property') || element.getAttribute('name')
    if (property && content && 
       (property.includes('og:image') || 
        property.includes('og:url') || 
        property.includes('twitter:image'))) {
      try {
        const url = new URL(content, this.baseURL)
        const newURL = `https://${this.proxyDomain}/${config.separator}${url.href}`
        element.setAttribute('content', newURL)
      } catch (e) {
        console.error(`Meta tag URL rewrite error:`, e)
      }
    }
  }
}

class BaseTagRewriter {
  constructor(baseURL, proxyDomain) {
    this.baseURL = baseURL
    this.proxyDomain = proxyDomain
  }
  
  element(element) {
    const href = element.getAttribute('href')
    if (href) {
      try {
        const url = new URL(href, this.baseURL)
        const newURL = `https://${this.proxyDomain}/${config.separator}${url.href}`
        element.setAttribute('href', newURL)
      } catch (e) {
        console.error(`Base tag URL rewrite error:`, e)
      }
    }
  }
}

class StyleAttributeRewriter {
  constructor(baseURL, proxyDomain) {
    this.baseURL = baseURL
    this.proxyDomain = proxyDomain
  }
  
  element(element) {
    const style = element.getAttribute('style')
    if (!style) return
    
    const rewrittenStyle = rewriteCSS(style, this.baseURL, this.proxyDomain)
    element.setAttribute('style', rewrittenStyle)
  }
}

class StyleElementRewriter {
  constructor(baseURL, proxyDomain) {
    this.baseURL = baseURL
    this.proxyDomain = proxyDomain
  }
  
  element(element) {
    element.onEndTag(endTag => {
      element.replace(endTag.before + endTag.name + endTag.after)
    })
  }
  
  text(text) {
    const rewrittenCSS = rewriteCSS(text.text, this.baseURL, this.proxyDomain)
    text.replace(rewrittenCSS)
  }
}

function rewriteCSS(css, baseURL, proxyDomain) {
  if (!css) return css
  
  css = css.replace(/@import\s+(?:url\(\s*['"]?([^'")]+)['"]?\s*\)|['"]([^'"]+)['"]).*/g, 
    function(match, urlMatch, directMatch) {
      const importUrl = urlMatch || directMatch
      if (!importUrl || importUrl.startsWith('data:') || importUrl.startsWith(`https://${proxyDomain}/`)) return match
      
      try {
        let normalizedUrl = importUrl
        if (normalizedUrl.startsWith('//')) {
          normalizedUrl = baseURL.protocol + normalizedUrl
        }
        
        const absoluteURL = new URL(normalizedUrl, baseURL)
        return match.replace(importUrl, `https://${proxyDomain}/${config.separator}${absoluteURL.href}`)
      } catch (e) {
        return match
      }
    }
  )
  
  css = css.replace(/url\(\s*(['"]?)([^'")]+)(['"]?)\s*\)/g, 
    function(match, quote1, url, quote2) {
      if (!url || url.startsWith('data:') || url.startsWith(`https://${proxyDomain}/`)) return match
      
      try {
        let normalizedUrl = url
        if (normalizedUrl.startsWith('//')) {
          normalizedUrl = baseURL.protocol + normalizedUrl
        }
        
        const absoluteURL = new URL(normalizedUrl, baseURL)
        return `url(${quote1}https://${proxyDomain}/${config.separator}${absoluteURL.href}${quote2})`
      } catch (e) {
        return match
      }
    }
  )
  
  css = css.replace(/image-set\(\s*(?:[^)]|(?:\([^)]*\)))+\)/g, 
    function(match) {
      return match.replace(/url\(\s*(['"]?)([^'")]+)(['"]?)\s*\)/g, 
        function(urlMatch, quote1, url, quote2) {
          if (!url || url.startsWith('data:') || url.startsWith(`https://${proxyDomain}/`)) return urlMatch
          
          try {
            let normalizedUrl = url
            if (normalizedUrl.startsWith('//')) {
              normalizedUrl = baseURL.protocol + normalizedUrl
            }
            
            const absoluteURL = new URL(normalizedUrl, baseURL)
            return `url(${quote1}https://${proxyDomain}/${config.separator}${absoluteURL.href}${quote2})`
          } catch (e) {
            return urlMatch
          }
        }
      )
    }
  )
  
  return css
}

function rewriteJavaScript(js, baseURL, proxyDomain) {
  if (!js) return js
  
  return js.replace(/'(https?:\/\/[^']+)'/g, function(match, url) {
    if (url.startsWith(`https://${proxyDomain}/`)) return match
    try {
      return `'https://${proxyDomain}/${config.separator}${url}'`
    } catch (e) {
      return match
    }
  }).replace(/"(https?:\/\/[^"]+)"/g, function(match, url) {
    if (url.startsWith(`https://${proxyDomain}/`)) return match
    try {
      return `"https://${proxyDomain}/${config.separator}${url}"`
    } catch (e) {
      return match
    }
  })
}


function getHomePage(ipInfoHtml) {
  return new Response(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CF Proxy Szolgáltatás</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      max-width: 800px;
      margin: 0 auto;
      padding: 20px;
      text-align: center;
      line-height: 1.6;
      color: #333;
      background-color: #f8f9fa;
    }
    .container {
      background-color: white;
      padding: 30px;
      border-radius: 8px;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
    }
    h1 {
      color: #2c3e50;
      margin: 20px 0;
    }
    form {
      margin: 30px 0;
    }
    .input-group {
      width: 100%;
      display: flex;
      margin-bottom: 15px;
    }
    input[type="text"] {
      flex: 1;
      padding: 12px;
      font-size: 16px;
      border: 1px solid #ddd;
      border-radius: 4px 0 0 4px;
      box-sizing: border-box;
    }
    button {
      background: #3498db;
      color: white;
      border: none;
      padding: 12px 20px;
      font-size: 16px;
      border-radius: 0 4px 4px 0;
      cursor: pointer;
      transition: background 0.3s;
    }
    button:hover {
      background: #2980b9;
    }
    .region-info {
        font-size: 14px;
        color: #e74c3c;
        margin-top: -10px;
        margin-bottom: 25px;
        font-weight: bold;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>CF Proxy Szolgáltatás</h1>
    
    ${ipInfoHtml} <p class="region-info">A kód megpróbált garantáltan USA IP-t találni a listából.</p>

    <form id="proxyForm" onsubmit="navigateToProxy(event)">
      <div class="input-group">
        <input type="text" id="urlInput" placeholder="https://example.com" autocomplete="off">
        <button type="submit">Access</button>
      </div>
    </form>
  </div>
  
  <script>
    function navigateToProxy(e) {
      e.preventDefault();
      const input = document.getElementById('urlInput').value.trim();
      if (!input) return;
      const hasScheme = /^https?:\/\//i.test(input);
      const looksLikeDomain = input.includes('.') && !input.startsWith(' ');
      let target;
      if (hasScheme) {
        target = input;
      } else if (looksLikeDomain) {
        target = 'https://' + input;
      } else {
        const q = encodeURIComponent(input);
        target = 'https://duckduckgo.com/?q=' + q;
      }
      // A separator üres, így a link tiszta lesz: /https://example.com
      window.location.href = '/'+ '' + target;
    }
    
    document.getElementById('urlInput').focus();
    
    document.getElementById('urlInput').addEventListener('paste', function(e) {
      setTimeout(function() {
        const url = e.target.value.trim();
        e.target.value = url.replace(/\\s+/g, '');
      }, 0);
    });
  </script>
</body>
</html>`, {
    headers: {
      'Content-Type': 'text/html;charset=UTF-8',
      'Cache-Control': 'no-cache'
    }
  })
}
