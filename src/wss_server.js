const https = require('https')
const http = require('http')
const http2 = require('http2')
const pem = require('pem')
const ws = require('ws')
const tls = require('tls')
const util = require('util')
const fs = require('fs')
const net = require('net')
const Readable = require('stream').Readable

const createCertificate = util.promisify(pem.createCertificate)

const version = 'v2'

const socketInfo = (socket) => {
    const result = `${socket.remoteAddress}:${socket.remotePort}`
    const dstAddress = socket.server.address()
    if (dstAddress.address) {
        return `${result} -> ${dstAddress.address}:${dstAddress.port}`
    } else {
        return result
    }
}

const wssServerWork = async (port, withCn) => {
    const certOptions = {
        days: 365,
        selfSigned: true
    }
    if (withCn) {
        certOptions.commonName = 'www.nonexistent.1.com'
        certOptions.altNames = ['www.nonexistent.2.com', 'www.nonexistent.3.com', '*.nonexistent.4.com']
    }
    const cert = await createCertificate(certOptions)
    const server = https.createServer({ key: cert.serviceKey, cert: cert.certificate })
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
    })
    wss.on('headers', (headers, req) => {
        headers.push(`templar-testing-server-version: ${version}`)
    })

    server.on('upgrade', function upgrade (req, sock, _) {
        console.log(`WebSocket client about to connect: ${sock.remoteAddress}:${sock.remotePort} on url: ${req.url}`)
        switch (req.url) {
            case '/evt_connect_fail_transport':
                sock.destroy()
                break
            default:
                wss.handleUpgrade(req, sock, _, (ws) => { wss.emit('connection', ws, req) })
                break
        }
    })

    server.listen(port)
}

const httpServerWork = async (httpPort, httpsPort) => {
    const requestListener = (req, res) => {
        console.log(`${req.connection.encrypted ? 'HTTPS' : 'HTTP'} client connected: ${req.socket.remoteAddress}:${req.socket.remotePort} on url: ${req.url}`)
        res.setHeader('templar-testing-server-version', version)
        switch (req.url) {
            case '/http_request_failed_transport':
                req.socket.destroy()
                break
            case '/http_response':
                res.end('Hello world!')
                break
            case '/http_response_and_close':
                res.setHeader('connection', 'close')
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
            case '/http_response_with_delay':
                setTimeout(() => {
                    res.end('Hello world!')
                }, 3000)
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
    const server = http2.createSecureServer({ key: cert.serviceKey, cert: cert.certificate }, requestListener)
    return server.listen(port)
}

const tlsServerDisconnectOnConnectWork = async (port) => {
    const cert = await createCertificate({ days: 365, selfSigned: true })
    const server = tls.createServer({ key: cert.serviceKey, cert: cert.certificate }, (socket) => {
        // . fd: ${socket._handle.fd}; class name: ${socket._handle.constructor.name}
        console.log(`TLS client connected: ${socketInfo(socket)}`)
        socket.on('error', () => { console.log(`TLS client error out: ${socketInfo(socket)}`) })
        socket.on('close', () => { console.log(`TLS client disconnected: ${socketInfo(socket)}`) })
        socket.destroy()
        console.log('TLS client destroyed')
    })
    server.listen(port)
}

const tlsServerDisconnectOnRecvWork = async (port) => {
    const cert = await createCertificate({ days: 365, selfSigned: true })
    const server = tls.createServer({ key: cert.serviceKey, cert: cert.certificate }, (socket) => {
        // . fd: ${socket._handle.fd}; class name: ${socket._handle.constructor.name}
        console.log(`TLS client connected: ${socketInfo(socket)}`)
        socket.on('error', () => { console.log(`TLS client error out: ${socketInfo(socket)}`) })
        socket.on('close', () => { console.log(`TLS client disconnected: ${socketInfo(socket)}`) })
        socket.on('data', (data) => {
            console.log(data.toString('utf8'))
            console.log(`TLS client will be disconnected: ${socketInfo(socket)}`)
            socket.destroy()
        })
    })
    server.listen(port)
}

const tlsServerDisconnectOnTimer = async (port) => {
    const cert = await createCertificate({ days: 365, selfSigned: true })
    const server = tls.createServer({ key: cert.serviceKey, cert: cert.certificate }, (socket) => {
        // . fd: ${socket._handle.fd}; class name: ${socket._handle.constructor.name}
        console.log(`TLS client connected: ${socketInfo(socket)}`)
        socket.on('error', () => { console.log(`TLS client error out: ${socketInfo(socket)}`) })
        socket.on('close', () => { console.log(`TLS client disconnected: ${socketInfo(socket)}`) })
        setTimeout(() => {
            console.log(`TLS client will be disconnected: ${socketInfo(socket)}`)
            socket.destroy()
        }, 5000)
    })
    server.listen(port)
}

const tcpServerDisconnectOnRecvWork = async (port) => {
    const server = net.createServer({}, (socket) => {
        console.log(`TCP client connected: ${socketInfo(socket)}`)
        socket.on('error', () => { console.log(`TCP client error out: ${socketInfo(socket)}`) })
        socket.on('data', (data) => {
            console.log(`TCP client will be disconnected: ${socketInfo(socket)}`)
            socket.destroy()
        })
    })
    server.listen(port)
}

// current values can never be changed. New values can be added
const ports = {
    wss: 9000,

    http1: 9001,
    http1s: 9002,

    http2s: 9003,

    tls_disconnect_on_connect: 9004,
    tls_disconnect_on_recv: 9005,

    tcp_disconnect_on_recv: 9006,

    tls_disconnect_on_timer: 9007,

    wss_with_cn: 9008
}

wssServerWork(ports.wss, false)

httpServerWork(ports.http1, ports.http1s)

http2ServerWork(ports.http2s)

tlsServerDisconnectOnConnectWork(ports.tls_disconnect_on_connect)
tlsServerDisconnectOnRecvWork(ports.tls_disconnect_on_recv)
tlsServerDisconnectOnTimer(ports.tls_disconnect_on_timer)
wssServerWork(ports.wss_with_cn, true)

tcpServerDisconnectOnRecvWork(ports.tcp_disconnect_on_recv)
