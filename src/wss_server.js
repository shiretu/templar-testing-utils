const HttpsServer = require('https').createServer
const pem = require('pem')
const WebSocketServer = require('ws').Server
const WebSocketStream = require('ws').createWebSocketStream
const util = require('util')
const fs = require('fs')

const createCertificate = util.promisify(pem.createCertificate)

const work = async () => {
    const cert = await createCertificate({
        days: 365,
        selfSigned: true
    })
    const httpsServer = HttpsServer({ key: cert.serviceKey, cert: cert.certificate })
    const wss = new WebSocketServer({
        // server: httpsServer
        noServer: true
    })
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
        headers.push('templar-testing-server-version: v1')
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

    httpsServer.listen(9443)
}

work()
