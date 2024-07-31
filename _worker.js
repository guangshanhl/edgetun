import { connect } from 'cloudflare:sockets';

let userID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
let proxyIP = '';

export default {
    async fetch(request, env) {
        try {
            userID = env.UUID || userID;
            proxyIP = env.PROXYIP || proxyIP;

            const upgradeHeader = request.headers.get('Upgrade');
            if (upgradeHeader !== 'websocket') {
                const url = new URL(request.url);

                switch (url.pathname) {
                    case '/':
                        return new Response(JSON.stringify(request.cf, null, 4), { status: 200 });
                    case `/${userID}`:
                        return new Response(getVLESSConfig(userID, request.headers.get('Host')), {
                            status: 200,
                            headers: { "Content-Type": "text/plain;charset=utf-8" }
                        });
                    default:
                        url.hostname = 'www.bing.com';
                        url.protocol = 'https:';
                        return await fetch(new Request(url, request));
                }
            } else {
                return await vlessOverWSHandler(request);
            }
        } catch (err) {
            return new Response(err.toString());
        }
    },
};

async function vlessOverWSHandler(request) {
    const webSocketPair = new WebSocketPair();
    const [client, webSocket] = Object.values(webSocketPair);
    webSocket.accept();

    let isDns = false;
    const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
    const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader);

    readableWebSocketStream.pipeTo(new WritableStream({
        async write(chunk) {
            if (isDns) {
                await handleUDPOutBound(webSocket, chunk);
            } else {
                const { hasError, addressRemote, portRemote, rawDataIndex, vlessVersion, isUDP } = processVlessHeader(chunk, userID);
                if (hasError) return;
                
                const vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]);
                const rawClientData = chunk.slice(rawDataIndex);

                if (isUDP) {
                    isDns = true;
                    await handleUDPOutBound(webSocket, rawClientData, vlessResponseHeader);
                } else {
                    await handleTCPOutBound(addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader);
                }
            }
        }
    })).catch(() => {});

    return new Response(null, {
        status: 101,
        webSocket: client,
    });
}

async function handleTCPOutBound(addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader) {
    const tcpSocket = await connectAndWrite(addressRemote, portRemote, rawClientData);
    remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, () => handleTCPOutBound(proxyIP || addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader));
}

async function connectAndWrite(address, port, rawClientData) {
    const tcpSocket = connect({ hostname: address, port: port });
    const writer = tcpSocket.writable.getWriter();
    await writer.write(rawClientData);
    writer.releaseLock();
    return tcpSocket;
}

function makeReadableWebSocketStream(webSocketServer, earlyDataHeader) {
    let readableStreamCancel = false;

    return new ReadableStream({
        start(controller) {
            webSocketServer.addEventListener('message', (event) => {
                if (!readableStreamCancel) controller.enqueue(event.data);
            });
            webSocketServer.addEventListener('close', () => controller.close());
            webSocketServer.addEventListener('error', (err) => controller.error(err));

            const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
            if (error) {
                controller.error(error);
            } else if (earlyData) {
                controller.enqueue(earlyData);
            }
        },
        cancel() {
            readableStreamCancel = true;
            safeCloseWebSocket(webSocketServer);
        }
    });
}

function processVlessHeader(vlessBuffer, userID) {
    if (vlessBuffer.byteLength < 24) return { hasError: true };

    const version = new Uint8Array(vlessBuffer.slice(0, 1));
    const isValidUser = stringify(new Uint8Array(vlessBuffer.slice(1, 17))) === userID;

    if (!isValidUser) return { hasError: true };

    const optLength = new Uint8Array(vlessBuffer.slice(17, 18))[0];
    const command = new Uint8Array(vlessBuffer.slice(18 + optLength, 18 + optLength + 1))[0];

    let isUDP = command === 2;
    if (![1, 2].includes(command)) return { hasError: true };

    const portIndex = 18 + optLength + 1;
    const portRemote = new DataView(vlessBuffer.slice(portIndex, portIndex + 2)).getUint16(0);
    let addressIndex = portIndex + 2;
    const addressType = new Uint8Array(vlessBuffer.slice(addressIndex, addressIndex + 1))[0];

    let addressLength = 0, addressValueIndex = addressIndex + 1, addressValue = '';
    switch (addressType) {
        case 1:
            addressLength = 4;
            addressValue = new Uint8Array(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join('.');
            break;
        case 2:
            addressLength = new Uint8Array(vlessBuffer.slice(addressValueIndex, addressValueIndex + 1))[0];
            addressValueIndex += 1;
            addressValue = new TextDecoder().decode(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
            break;
        case 3:
            addressLength = 16;
            const ipv6 = Array.from({ length: 8 }, (_, i) => new DataView(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).getUint16(i * 2).toString(16));
            addressValue = ipv6.join(':');
            break;
        default:
            return { hasError: true };
    }

    if (!addressValue) return { hasError: true };

    return { hasError: false, addressRemote: addressValue, portRemote, rawDataIndex: addressValueIndex + addressLength, vlessVersion: version, isUDP };
}

async function remoteSocketToWS(remoteSocket, webSocket, vlessResponseHeader, retry) {
    let hasIncomingData = false;
    await remoteSocket.readable.pipeTo(new WritableStream({
        async write(chunk) {
            hasIncomingData = true;
            if (webSocket.readyState !== WS_READY_STATE_OPEN) throw new Error('readyState is not open');
            webSocket.send(vlessResponseHeader ? await new Blob([vlessResponseHeader, chunk]).arrayBuffer() : chunk);
            vlessResponseHeader = null;
        }
    })).catch(() => safeCloseWebSocket(webSocket));

    if (!hasIncomingData && retry) retry();
}

async function handleUDPOutBound(webSocket, chunk, vlessResponseHeader) {
    let isVlessHeaderSent = false;
    const transformStream = new TransformStream({
        transform(chunk, controller) {
            for (let index = 0; index < chunk.byteLength;) {
                const udpPakcetLength = new DataView(chunk.slice(index, index + 2)).getUint16(0);
                controller.enqueue(new Uint8Array(chunk.slice(index + 2, index + 2 + udpPakcetLength)));
                index += 2 + udpPakcetLength;
            }
        }
    });

    transformStream.readable.pipeTo(new WritableStream({
        async write(chunk) {
            const resp = await fetch('https://cloudflare-dns.com/dns-query', {
                method: 'POST',
                headers: { 'content-type': 'application/dns-message' },
                body: chunk
            });

            const dnsQueryResult = await resp.arrayBuffer();
            const udpSizeBuffer = new Uint8Array([(dnsQueryResult.byteLength >> 8) & 0xff, dnsQueryResult.byteLength & 0xff]);

            if (webSocket.readyState === WS_READY_STATE_OPEN) {
                const blobParts = isVlessHeaderSent ? [udpSizeBuffer, dnsQueryResult] : [vlessResponseHeader, udpSizeBuffer, dnsQueryResult];
                webSocket.send(await new Blob(blobParts).arrayBuffer());
                isVlessHeaderSent = true;
            }
        }
    })).catch(() => {});

    const writer = transformStream.writable.getWriter();
    await writer.write(chunk);
}

function base64ToArrayBuffer(base64Str) {
    if (!base64Str) return { error: null };

    try {
        base64Str = base64Str.replace(/-/g, '+').replace(/_/g, '/');
        const decode = atob(base64Str);
        const arrayBuffer = Uint8Array.from(decode, (c) => c.charCodeAt(0));
        return { earlyData: arrayBuffer.buffer, error: null };
    } catch (error) {
        return { error };
    }
}

const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;

function safeCloseWebSocket(socket) {
    try {
        if ([WS_READY_STATE_OPEN, WS_READY_STATE_CLOSING].includes(socket.readyState)) {
            socket.close();
        }
    } catch {
    }
}

function stringify(arr) {
    const byteToHex = Array.from({ length: 256 }, (_, i) => (i + 256).toString(16).slice(1));
    return Array.from({ length: 16 }, (_, i) => byteToHex[arr[i]]).join('').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5').toLowerCase();
}

function getVLESSConfig(userID, hostName) {
    return `
vless://${userID}\u0040${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}
`;
}
