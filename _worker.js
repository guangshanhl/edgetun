import { connect } from 'cloudflare:sockets';

let userID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
let proxyIP = '';

if (!isValidUUID(userID)) {
    throw new Error('UUID is not valid');
}

export default {
    async fetch(request, env, ctx) {
        try {
            userID = env.UUID || userID;
            proxyIP = env.PROXYIP || proxyIP;
            const upgradeHeader = request.headers.get('Upgrade');
            if (!upgradeHeader || upgradeHeader !== 'websocket') {
                const url = new URL(request.url);
                switch (url.pathname) {
                    case '/':
                        return new Response(JSON.stringify(request.cf, null, 4), { status: 200 });
                    case `/${userID}`: {
                        const vlessConfig = getVLESSConfig(userID, request.headers.get('Host'));
                        return new Response(`${vlessConfig}`, {
                            status: 200,
                            headers: {
                                "Content-Type": "text/plain;charset=utf-8",
                            },
                        });
                    }
                    default:
                        return new Response('Not found', { status: 404 });
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
    let address = '';
    const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
    const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader);
    let remoteSocketWrapper = {
        value: null,
    };
    let udpStreamWrite = null;
    let isDns = false;

    readableWebSocketStream.pipeTo(new WritableStream({
        async write(chunk, controller) {
            if (isDns && udpStreamWrite) {
                return udpStreamWrite(chunk);
            }
            if (remoteSocketWrapper.value) {
                const writer = remoteSocketWrapper.value.writable.getWriter();
                await writer.write(chunk);
                writer.releaseLock();
                return;
            }
            const {
                hasError,
                message,
                portRemote = 443,
                addressRemote = '',
                rawDataIndex,
                vlessVersion = new Uint8Array([0, 0]),
                isUDP,
            } = processVlessHeader(chunk, userID);
            address = addressRemote;
            if (hasError) {
                throw new Error(message);
            }
            if (isUDP) {
                if (portRemote === 53) {
                    isDns = true;
                } else {
                    throw new Error('UDP proxy only supports port 53');
                }
            }
            const vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]);
            const rawClientData = chunk.slice(rawDataIndex);
            if (isDns) {
                const { write } = await handleUDPOutBound(webSocket, vlessResponseHeader);
                udpStreamWrite = write;
                udpStreamWrite(rawClientData);
                return;
            }
            handleTCPOutBound(remoteSocketWrapper, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader);
        },
        close() {},
        abort(reason) {},
    })).catch((err) => {});

    return new Response(null, {
        status: 101,
        webSocket: client,
    });
}

async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader) {
    async function connectAndWrite(address, port) {
        const tcpSocket = connect({ hostname: address, port: port });
        remoteSocket.value = tcpSocket;
        const writer = tcpSocket.writable.getWriter();
        await writer.write(rawClientData);
        writer.releaseLock();
        return tcpSocket;
    }
    async function retry() {
        const tcpSocket = await connectAndWrite(proxyIP || addressRemote, portRemote);
        tcpSocket.closed.catch(error => {}).finally(() => {
            safeCloseWebSocket(webSocket);
        });
        remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, null);
    }
    const tcpSocket = await connectAndWrite(addressRemote, portRemote);
    remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, retry);
}

function makeReadableWebSocketStream(webSocketServer, earlyDataHeader) {
    let readableStreamCancel = false;
    const stream = new ReadableStream({
        start(controller) {
            webSocketServer.addEventListener('message', (event) => {
                if (readableStreamCancel) return;
                const message = event.data;
                controller.enqueue(message);
            });
            webSocketServer.addEventListener('close', () => {
                safeCloseWebSocket(webSocketServer);
                if (readableStreamCancel) return;
                controller.close();
            });
            webSocketServer.addEventListener('error', (err) => {
                controller.error(err);
            });
            const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
            if (error) {
                controller.error(error);
            } else if (earlyData) {
                controller.enqueue(earlyData);
            }
        },
        pull(controller) {},
        cancel(reason) {
            if (readableStreamCancel) return;
            readableStreamCancel = true;
            safeCloseWebSocket(webSocketServer);
        },
    });
    return stream;
}

function processVlessHeader(vlessBuffer, userID) {
    if (vlessBuffer.byteLength < 24) {
        return { hasError: true };
    }
    const version = vlessBuffer[0];
    const userIDBuffer = vlessBuffer.slice(1, 17);
    if (unsafeStringify(userIDBuffer) !== userID) {
        return { hasError: true };
    }
    const optLength = vlessBuffer[17];
    const command = vlessBuffer[18 + optLength];
    if (command !== 1 && command !== 2) {
        return { hasError: true };
    }
    const portRemote = (vlessBuffer[18 + optLength + 1] << 8) | vlessBuffer[18 + optLength + 2];
    const addressType = vlessBuffer[18 + optLength + 3];
    let addressValue = '';
    const addressLength = addressType === 1 ? 4 : addressType === 2 ? vlessBuffer[18 + optLength + 4] : 16;
    const addressStart = 18 + optLength + 4 + (addressType === 2 ? 1 : 0);
    if (addressType === 1) {
        addressValue = Array.from(vlessBuffer.slice(addressStart, addressStart + 4)).join('.');
    } else if (addressType === 2) {
        addressValue = new TextDecoder().decode(vlessBuffer.slice(addressStart, addressStart + addressLength));
    } else {
        const ipv6 = [];
        for (let i = 0; i < 8; i++) {
            ipv6.push(((vlessBuffer[addressStart + i * 2] << 8) | vlessBuffer[addressStart + i * 2 + 1]).toString(16));
        }
        addressValue = ipv6.join(':');
    }
    return {
        hasError: false,
        addressRemote: addressValue,
        addressType,
        portRemote,
        rawDataIndex: addressStart + addressLength,
        vlessVersion: [version],
        isUDP: command === 2,
    };
}

async function remoteSocketToWS(remoteSocket, webSocket, vlessResponseHeader, retry) {
    let remoteChunkCount = 0;
    let chunks = [];
    let vlessHeader = vlessResponseHeader;
    let hasIncomingData = false;
    await remoteSocket.readable.pipeTo(new WritableStream({
        start() {},
        async write(chunk, controller) {
            hasIncomingData = true;
            if (webSocket.readyState !== WS_READY_STATE_OPEN) {
                controller.error('webSocket.readyState is not open, maybe close');
            }
            if (vlessHeader) {
                webSocket.send(await new Blob([vlessHeader, chunk]).arrayBuffer());
                vlessHeader = null;
            } else {
                webSocket.send(chunk);
            }
        },
        close() {},
        abort(reason) {},
    })).catch((error) => {
        console.error(`remoteSocketToWS has exception `, error.stack || error);
        safeCloseWebSocket(webSocket);
    });
    if (hasIncomingData === false && retry) {
        retry();
    }
}

function base64ToArrayBuffer(base64Str) {
    if (!base64Str) {
        return { error: null };
    }
    try {
        base64Str = base64Str.replace(/-/g, '+').replace(/_/g, '/');
        const decode = atob(base64Str);
        const arrayBuffer = Uint8Array.from(decode, (c) => c.charCodeAt(0));
        return { earlyData: arrayBuffer.buffer, error: null };
    } catch (error) {
        return { error };
    }
}

function isValidUUID(uuid) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(uuid);
}

const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;

function safeCloseWebSocket(socket) {
    try {
        if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
            socket.close();
        }
    } catch (error) {
        console.error('safeCloseWebSocket error', error);
    }
}

const byteToHex = [];
for (let i = 0; i < 256; ++i) {
    byteToHex.push((i + 256).toString(16).slice(1));
}

function unsafeStringify(arr, offset = 0) {
    return (byteToHex[arr[offset + 0]] +
        byteToHex[arr[offset + 1]] +
        byteToHex[arr[offset + 2]] +
        byteToHex[arr[offset + 3]] +
        "-" +
        byteToHex[arr[offset + 4]] +
        byteToHex[arr[offset + 5]] +
        "-" +
        byteToHex[arr[offset + 6]] +
        byteToHex[arr[offset + 7]] +
        "-" +
        byteToHex[arr[offset + 8]] +
        byteToHex[arr[offset + 9]] +
        "-" +
        byteToHex[arr[offset + 10]] +
        byteToHex[arr[offset + 11]] +
        byteToHex[arr[offset + 12]] +
        byteToHex[arr[offset + 13]] +
        byteToHex[arr[offset + 14]] +
        byteToHex[arr[offset + 15]]).toLowerCase();
}

function stringify(arr, offset = 0) {
    const uuid = unsafeStringify(arr, offset);
    if (!isValidUUID(uuid)) {
        throw TypeError("Stringified UUID is invalid");
    }
    return uuid;
}

async function handleUDPOutBound(webSocket, vlessResponseHeader) {
    let isVlessHeaderSent = false;
    const transformStream = new TransformStream({
        start(controller) {},
        transform(chunk, controller) {
            for (let index = 0; index < chunk.byteLength;) {
                const lengthBuffer = chunk.slice(index, index + 2);
                const udpPacketLength = new DataView(lengthBuffer).getUint16(0);
                const udpData = new Uint8Array(chunk.slice(index + 2, index + 2 + udpPacketLength));
                index = index + 2 + udpPacketLength;
                controller.enqueue(udpData);
            }
        },
        flush(controller) {},
    });
    transformStream.readable.pipeTo(new WritableStream({
        async write(chunk) {
            const resp = await fetch('https://cloudflare-dns.com/dns-query', {
                method: 'POST',
                headers: {
                    'content-type': 'application/dns-message',
                },
                body: chunk,
            });
            const dnsQueryResult = await resp.arrayBuffer();
            const udpSize = dnsQueryResult.byteLength;
            const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);
            if (webSocket.readyState === WS_READY_STATE_OPEN) {
                if (isVlessHeaderSent) {
                    webSocket.send(await new Blob([udpSizeBuffer, dnsQueryResult]).arrayBuffer());
                } else {
                    webSocket.send(await new Blob([vlessResponseHeader, udpSizeBuffer, dnsQueryResult]).arrayBuffer());
                    isVlessHeaderSent = true;
                }
            }
        },
    })).catch((error) => {});
    const writer = transformStream.writable.getWriter();
    return {
        write(chunk) {
            writer.write(chunk);
        },
    };
}

function getVLESSConfig(userID, hostName) {
    const vlessMain = `vless://${userID}@${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}`;
    return `
################################################################
v2ray
---------------------------------------------------------------
${vlessMain}
---------------------------------------------------------------
################################################################
`;
}
