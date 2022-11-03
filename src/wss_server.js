const https = require('https')
const http = require('http')
const http2 = require('http2')
const pem = require('pem')
const ws = require('ws')
const tls = require('tls')
const util = require('util')
const fs = require('fs')
const Readable = require('stream').Readable

const createCertificate = util.promisify(pem.createCertificate)

const version = 'v2'

const wssServerWork = async (port) => {
    const cert = await createCertificate({
        days: 365,
        selfSigned: true
    })
    const httpsServer = https.createServer({ key: cert.serviceKey, cert: cert.certificate })
    const wss = new ws.Server({ noServer: true })
    wss.on('connection', (wsConn, req) => {
        console.log(`WebSocket client connected: ${wsConn._socket.remoteAddress}:${wsConn._socket.remotePort} on url: ${req.url}`)

        const errorHandling = () => {
            console.log(`WebSocket client disconnected: ${wsConn._socket.remoteAddress}:${wsConn._socket.remotePort} on url: ${req.url}`)
        }

        wsConn.on('error', errorHandling)
        switch (req.url) {
            case '/evt_connected':
                // wsConn.close()
                break
            case '/evt_disconnected_transport':
                setTimeout(() => {
                    fs.close(wsConn._socket._handle.fd)
                    wsConn.close()
                }, 1000)
                break
            case '/evt_disconnected_websocket':
                setTimeout(() => { wsConn.close(1000, 'Bang!!!') }, 200)
                break
            case '/evt_recv_bin':
                setTimeout(() => { wsConn.send(Buffer.alloc(5, 'a')) }, 200)
                break
            case '/evt_recv_text':
                setTimeout(() => { wsConn.send('Ding dong!') }, 200)
                break
            case '/evt_recv_ping':
                wsConn.on('pong', (data) => { console.log(`got pong back: ${data}`) })
                setTimeout(() => { wsConn.ping('Ping data') }, 200)
                break
            case '/evt_recv_pong':
                setTimeout(() => { wsConn.pong('Pong data') }, 200)
                break
            default:
            {
                console.log(`Invalid request: ${req.url}`)
                wsConn.close()
            }
        }

        // const wsStream = new WebSocketStream(wsConn)
        // const devZero = fs.createReadStream('/dev/zero')

        // devZero.pipe(wsStream).on('error', errorHandling)
        // wsStream.pipe(process.stdout).on('error', errorHandling)
    })
    wss.on('headers', (headers, req) => {
        headers.push(`templar-testing-server-version: ${version}`)
    })

    httpsServer.on('upgrade', function upgrade (req, sock, _) {
        console.log(`WebSocket client about to connect: ${sock.remoteAddress}:${sock.remotePort} on url: ${req.url}`)
        switch (req.url) {
            case '/evt_connect_fail_transport':
                sock.destroy()
                break
            default:
                wss.handleUpgrade(req, sock, _, (ws) => { wss.emit('connection', ws, req) })
                break
        }
        // const { pathname } = parse(request.url)

        // if (pathname === '/foo') {
        //     wss1.handleUpgrade(request, socket, head, function done (ws) {
        //         wss1.emit('connection', ws, request)
        //     })
        // } else if (pathname === '/bar') {
        //     wss2.handleUpgrade(request, socket, head, function done (ws) {
        //         wss2.emit('connection', ws, request)
        //     })
        // } else {
        //     socket.destroy()
        // }
    })

    httpsServer.listen(port)
}

const httpServerWork = async (httpPort, httpsPort) => {
    const requestListener = (req, res) => {
        console.log(`HTTP(S) client connected: ${req.socket.remoteAddress}:${req.socket.remotePort} on url: ${req.url}`)
        res.setHeader('templar-testing-server-version', version)
        switch (req.url) {
            case '/http_request_failed_transport':
                req.socket.destroy()
                break
            case '/http_response':
                res.end('Hello world!')
                break
            case '/http_response_extra_headers':
                if (req.headers.custom) { res.setHeader('custom', req.headers.custom) }
                res.end('Hello world!')
                break
            case '/http_response_extra_data':
                req.on('readable', () => {
                    if (!req.complete) return
                    const data = req.read()
                    res.end(data)
                })
                break
            case '/http_response_extra_headers_and_data':
                if (req.headers.custom) { res.setHeader('custom', req.headers.custom) }
                req.on('readable', () => {
                    if (!req.complete) return
                    const data = req.read()
                    res.end(data)
                })
                break
            case '/http_chunked_response':
            {
                let count = 0
                const s = new Readable({
                    read (size) {
                        this.push('a'.repeat(count + 1))
                        if (count === 127) this.push(null)
                        count++
                    },
                    highWaterMark: 1
                })
                s.pipe(res)
                break
            }
            default:
                break
        }
    }

    const cert = await createCertificate({ days: 365, selfSigned: true })
    const httpsServer = https.createServer({ key: cert.serviceKey, cert: cert.certificate }, requestListener)
    const httpServer = http.createServer({ keepAlive: true, keepAliveTimeout: 3600 * 1000 }, requestListener)
    httpServer.listen(httpPort)
    httpsServer.listen(httpsPort)
}

const http2ServerWork = async (port) => {
    const requestListener = (req, res) => {
        console.log(`HTTP2 client connected: ${req.socket.remoteAddress}:${req.socket.remotePort}`)
        console.log('req\n', req.headers)
        res.setHeader('aloha', 'Hi there')
        console.log('res\n', res.getHeaders())
        res.end('Hello world!')
    }

    const cert = await createCertificate({ days: 365, selfSigned: true })
    const http2Server = http2.createSecureServer({ key: cert.serviceKey, cert: cert.certificate }, requestListener)
    return http2Server.listen(port)
}

const tlsServerDisconnectOnConnectWork = async (port) => {
    const cert = await createCertificate({ days: 365, selfSigned: true })
    const tlsServer = tls.createServer({ key: cert.serviceKey, cert: cert.certificate }, (socket) => {
        // . fd: ${socket._handle.fd}; class name: ${socket._handle.constructor.name}
        console.log('TLS client connected')
        socket.on('error', () => { console.log('TLS client disconnected') })
        socket.destroy()
        console.log('TLS client destroyed')
    })
    tlsServer.listen(port)
}

const tlsServerDisconnectOnRecvWork = async (port) => {
    const cert = await createCertificate({ days: 365, selfSigned: true })
    const tlsServer = tls.createServer({ key: cert.serviceKey, cert: cert.certificate }, (socket) => {
        // . fd: ${socket._handle.fd}; class name: ${socket._handle.constructor.name}
        console.log('TLS client connected')
        socket.on('error', () => { console.log('TLS client disconnected') })
        socket.on('data', (data) => {
            console.log(data.toString('utf8'))
            socket.destroy()
            console.log('TLS client destroyed')
        })
    })
    tlsServer.listen(port)
}

wssServerWork(9443) // deprecated
wssServerWork(9000)

httpServerWork(8000, 8443) // deprecated
httpServerWork(9001, 9002)

http2ServerWork(7443) // deprecated
http2ServerWork(9003)

tlsServerDisconnectOnConnectWork(9004)
tlsServerDisconnectOnRecvWork(9005)
