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
        server: httpsServer
    })
    wss.on('connection', (wsConn, req) => {
        console.log(`WebSocket client connected: ${wsConn._socket.remoteAddress}:${wsConn._socket.remotePort} on url: ${req.url}`)
        if (req.url === '/disconnect_raw') {
            setTimeout(() => {
                fs.close(wsConn._socket._handle.fd)
                wsConn.close()
            }, 1000)
            return
        }

        if (req.url === '/disconnect_normal') {
            setTimeout(() => { wsConn.close(1000, 'dang!') }, 1000)
            return
        }

        const wsStream = new WebSocketStream(wsConn)
        const devZero = fs.createReadStream('/dev/zero')
        const errorHandling = () => {
            console.log(`WebSocket client disconnected: ${wsConn._socket.remoteAddress}:${wsConn._socket.remotePort} on url: ${req.url}`)
        }
        devZero.pipe(wsStream).on('error', errorHandling)
        wsStream.pipe(process.stdout).on('error', errorHandling)
    })

    const listenPortFilePath = process.env.NODE_LISTEN_PORT_FILE_PATH
    if (listenPortFilePath) {
        httpsServer.listen(0, () => {
            console.log(`Listening on port ${httpsServer.address().port}`)
            fs.writeFile(listenPortFilePath, `${httpsServer.address().port}`, 'utf8', () => {})
        })
    } else {
        httpsServer.listen(9443)
    }
}

work()
