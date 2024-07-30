import { connect } from 'cloudflare:sockets';

const userID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
const proxyIP = '';

if (!isValidUUID(userID)) {
    throw new Error('UUID is not valid');
}

export default {
    async fetch(request, env) {
        try {
            const currentUserID = env.UUID || userID;
            const currentProxyIP = env.PROXYIP || proxyIP;
            const upgradeHeader = request.headers.get('Upgrade');

            if (upgradeHeader !== 'websocket') {
                const url = new URL(request.url);
                switch (url.pathname) {
                    case '/':
                        return new Response(JSON.stringify(request.cf, null, 4), { status: 200 });
                    case `/${currentUserID}`:
                        return new Response(getVLESSConfig(currentUserID, request.headers.get('Host')), {
                            status: 200,
                            headers: { "Content-Type": "text/plain;charset=utf-8" }
                        });
                    default:
                        url.hostname = 'www.bing.com';
                        url.protocol = 'https:';
                        return fetch(new Request(url, request));
                }
            } else {
                return vlessOverWSHandler(request, currentUserID, currentProxyIP);
            }
        } catch (err) {
            return new Response(err.toString());
        }
    }
};

async function vlessOverWSHandler(request, userID, proxyIP) {
    const [client, webSocket] = Object.values(new WebSocketPair());
    webSocket.accept();

    const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
    const readableStream = makeReadableWebSocketStream(webSocket, earlyDataHeader);
    let remoteSocket = null;
    let udpStreamWrite = null;
    let isDns = false;

    readableStream.pipeTo(new WritableStream({
        async write(chunk, controller) {
            if (isDns && udpStreamWrite) {
                return udpStreamWrite(chunk);
            }

            if (remoteSocket) {
                const writer = remoteSocket.writable.getWriter();
                await writer.write(chunk);
                writer.releaseLock();
                return;
            }

            const { hasError, message, portRemote, addressRemote, rawDataIndex, vlessVersion, isUDP } = processVlessHeader(chunk, userID);

            if (hasError) throw new Error(message);

            if (isUDP) {
                if (portRemote === 53) {
                    isDns = true;
                } else {
                    throw new Error('UDP proxy only allowed for DNS (port 53)');
                }
            }

            const vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]);
            const rawClientData = chunk.slice(rawDataIndex);

            if (isDns) {
                const { write } = await handleUDPOutBound(webSocket, vlessResponseHeader);
                udpStreamWrite = write;
                udpStreamWrite(rawClientData);
            } else {
                await handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, proxyIP);
            }
        }
    }).catch(console.error));

    return new Response(null, { status: 101, webSocket: client });
}

async function handleTCPOutBound(remoteSocket, address, port, rawData, webSocket, vlessResponseHeader, proxyIP) {
    async function connectAndWrite(addr, port) {
        const tcpSocket = connect({ hostname: addr, port });
        remoteSocket = tcpSocket;
        const writer = tcpSocket.writable.getWriter();
        await writer.write(rawData);
        writer.releaseLock();
        return tcpSocket;
    }

    const tcpSocket = await connectAndWrite(address, port);
    remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, async () => {
        const retrySocket = await connectAndWrite(proxyIP || address, port);
        retrySocket.closed.catch(console.error).finally(() => safeCloseWebSocket(webSocket));
        remoteSocketToWS(retrySocket, webSocket, vlessResponseHeader, null);
    });
}

function makeReadableWebSocketStream(webSocket, earlyDataHeader) {
    let canceled = false;
    return new ReadableStream({
        start(controller) {
            webSocket.addEventListener('message', event => {
                if (!canceled) {
                    controller.enqueue(event.data);
                }
            });
            webSocket.addEventListener('close', () => {
                if (!canceled) {
                    controller.close();
                }
            });
            webSocket.addEventListener('error', err => controller.error(err));
            const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
            if (error) {
                controller.error(error);
            } else if (earlyData) {
                controller.enqueue(earlyData);
            }
        },
        cancel() {
            if (!canceled) {
                canceled = true;
                safeCloseWebSocket(webSocket);
            }
        }
    });
}

function processVlessHeader(vlessBuffer, userID) {
    if (vlessBuffer.byteLength < 24) return { hasError: true };

    const version = new Uint8Array(vlessBuffer.slice(0, 1));
    const isValidUser = stringify(new Uint8Array(vlessBuffer.slice(1, 17))) === userID;

    if (!isValidUser) return { hasError: true };

    const optLength = new Uint8Array(vlessBuffer.slice(17, 18))[0];
    const command = new Uint8Array(vlessBuffer.slice(18 + optLength, 19 + optLength))[0];
    let isUDP = command === 2;

    if (![1, 2].includes(command)) return { hasError: true };

    const portRemote = new DataView(vlessBuffer.slice(18 + optLength + 1, 20 + optLength)).getUint16(0);
    const addressType = new Uint8Array(vlessBuffer.slice(20 + optLength, 21 + optLength))[0];
    let addressValue = '';

    switch (addressType) {
        case 1:
            addressValue = Array.from(new Uint8Array(vlessBuffer.slice(21 + optLength, 25 + optLength)))
                .join('.');
            break;
        case 2:
            addressValue = new TextDecoder().decode(
                vlessBuffer.slice(22 + optLength, 22 + optLength + new Uint8Array(vlessBuffer.slice(21 + optLength, 22 + optLength))[0])
            );
            break;
        case 3:
            addressValue = Array.from(new DataView(vlessBuffer.slice(21 + optLength, 37 + optLength)))
                .map((byte, i) => (i % 2 ? '' : ':') + byte.toString(16))
                .join('');
            break;
        default:
            return { hasError: true };
    }

    return {
        hasError: false,
        addressRemote: addressValue,
        portRemote,
        rawDataIndex: 21 + optLength + (addressType === 2 ? new Uint8Array(vlessBuffer.slice(21 + optLength, 22 + optLength))[0] : 16),
        vlessVersion: version,
        isUDP
    };
}

async function remoteSocketToWS(remoteSocket, webSocket, vlessResponseHeader, retry) {
    let hasIncomingData = false;
    await remoteSocket.readable.pipeTo(new WritableStream({
        async write(chunk, controller) {
            hasIncomingData = true;
            if (webSocket.readyState !== WebSocket.OPEN) {
                controller.error('WebSocket is not open');
                return;
            }
            webSocket.send(await new Blob([vlessResponseHeader, chunk]).arrayBuffer());
        }
    }).catch(() => safeCloseWebSocket(webSocket)));

    if (!hasIncomingData && retry) retry();
}

function base64ToArrayBuffer(base64Str) {
    try {
        base64Str = base64Str.replace(/-/g, '+').replace(/_/g, '/');
        const decoded = atob(base64Str);
        return { earlyData: Uint8Array.from(decoded, c => c.charCodeAt(0)).buffer, error: null };
    } catch (error) {
        return { error };
    }
}

function isValidUUID(uuid) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid);
}

function safeCloseWebSocket(socket) {
    try {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CLOSING) {
            socket.close();
        }
    } catch (error) {
    }
}

function stringify(arr, offset = 0) {
    const uuid = Array.from(arr.slice(offset, offset + 16))
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join('')
        .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5')
        .toLowerCase();
    if (!isValidUUID(uuid)) throw new Error("Invalid UUID");
    return uuid;
}

async function handleUDPOutBound(webSocket, vlessResponseHeader) {
    let isVlessHeaderSent = false;
    const transformStream = new TransformStream({
        transform(chunk, controller) {
            for (let index = 0; index < chunk.byteLength;) {
                const lengthBuffer = chunk.slice(index, index + 2);
                const udpPakcetLength = new DataView(lengthBuffer).getUint16(0);
                const udpData = new Uint8Array(chunk.slice(index + 2, index + 2 + udpPakcetLength));
                index += 2 + udpPakcetLength;
                controller.enqueue(udpData);
            }
        }
    });
    transformStream.readable.pipeTo(new WritableStream({
        async write(chunk) {
            const resp = await fetch('https://cloudflare-dns.com/dns-query', {
                method: 'POST',
                headers: { 'content-type': 'application/dns-message' },
                body: chunk,
            });
            const dnsQueryResult = await resp.arrayBuffer();
            const udpSizeBuffer = new Uint8Array([(dnsQueryResult.byteLength >> 8) & 0xff, dnsQueryResult.byteLength & 0xff]);

            if (webSocket.readyState === WebSocket.OPEN) {
                webSocket.send(await new Blob([isVlessHeaderSent ? udpSizeBuffer : vlessResponseHeader, udpSizeBuffer, dnsQueryResult]).arrayBuffer());
                isVlessHeaderSent = true;
            }
        }
    }).catch(console.error));
    const writer = transformStream.writable.getWriter();
    return { write: chunk => writer.write(chunk) };
}

function getVLESSConfig(userID, hostName) {
    return `
################################################################
v2ray
---------------------------------------------------------------
vless://${userID}\u0040${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}
---------------------------------------------------------------
################################################################
`;
}
