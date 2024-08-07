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
                return handleHTTPRequests(request);
            } else {
                return await vlessOverWSHandler(request);
            }
        } catch (err) {
            return new Response(err.toString());
        }
    },
};

async function handleHTTPRequests(request) {
    const url = new URL(request.url);
    switch (url.pathname) {
        case '/':
            return new Response(JSON.stringify(request.cf, null, 4), { status: 200 });
        case `/${userID}`:
            return new Response(getVLESSConfig(userID, request.headers.get('Host')), {
                status: 200,
                headers: { 
                    "Content-Type": "text/plain;charset=utf-8",
                    "Alt-Svc": 'h3=":443"; ma=86400'
                }
            });
        default:
            return new Response('Not found', { status: 404 });
    }
}

async function vlessOverWSHandler(request) {
    const webSocketPair = new WebSocketPair();
    const [client, webSocket] = Object.values(webSocketPair);
    webSocket.accept();

    const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
    const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader);
    let remoteSocketWapper = { value: null };
    let udpStreamWrite = null;
    let isDns = false;

    try {
        await readableWebSocketStream.pipeTo(new WritableStream({
            async write(chunk) {
                if (isDns && udpStreamWrite) {
                    return udpStreamWrite(chunk);
                }
                if (remoteSocketWapper.value) {
                    const writer = remoteSocketWapper.value.writable.getWriter();
                    await writer.write(chunk);
                    writer.releaseLock();
                    return;
                }

                const { hasError, portRemote = 443, addressRemote, rawDataIndex, vlessVersion = new Uint8Array([0, 0]), isUDP } = processVlessHeader(chunk, userID);
                if (hasError) return;

                if (isUDP) {
                    if (portRemote === 53) {
                        isDns = true;
                    } else {
                        return;
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

                handleTCPOutBound(remoteSocketWapper, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader);
            },
        }));
    } catch (err) {
        console.error('Error handling WebSocket stream:', err);
    }

    return new Response(null, { status: 101, webSocket: client });
}

async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader) {
    const connectAndWrite = async (address, port) => {
        const tcpSocket = connect({ hostname: address, port });
        remoteSocket.value = tcpSocket;
        const writer = tcpSocket.writable.getWriter();
        await writer.write(rawClientData);
        writer.releaseLock();
        return tcpSocket;
    };

    const retry = async () => {
        try {
            const tcpSocket = await connectAndWrite(proxyIP || addressRemote, portRemote);
            tcpSocket.closed.catch(console.error).finally(() => safeCloseWebSocket(webSocket));
            remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, null);
        } catch (err) {
            console.error('Retry connection failed:', err);
        }
    };

    try {
        const tcpSocket = await connectAndWrite(addressRemote, portRemote);
        remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, retry);
    } catch (err) {
        console.error('Initial TCP connection failed:', err);
        retry();
    }
}

function makeReadableWebSocketStream(webSocketServer, earlyDataHeader) {
    let readableStreamCancel = false;
    const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
    if (error) {
        console.error('Error converting early data header:', error);
    }

    return new ReadableStream({
        start(controller) {
            webSocketServer.addEventListener('message', event => {
                if (!readableStreamCancel) {
                    controller.enqueue(event.data);
                }
            });
            webSocketServer.addEventListener('close', () => {
                safeCloseWebSocket(webSocketServer);
                if (!readableStreamCancel) {
                    controller.close();
                }
            });
            webSocketServer.addEventListener('error', controller.error.bind(controller));

            if (earlyData) {
                controller.enqueue(earlyData);
            }
        },
        cancel(reason) {
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

    const optLength = vlessBuffer[17];
    const command = vlessBuffer[18 + optLength];
    const isUDP = command === 2;

    const portIndex = 18 + optLength + 1;
    const portBuffer = vlessBuffer.slice(portIndex, portIndex + 2);
    const portRemote = new DataView(portBuffer).getUint16(0);

    let addressValue = '';
    let addressValueIndex = portIndex + 2;
    const addressType = vlessBuffer[addressValueIndex++];
    let addressLength = 0;

    switch (addressType) {
        case 1:
            addressLength = 4;
            addressValue = Array.from(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join('.');
            break;
        case 2:
            addressLength = vlessBuffer[addressValueIndex++];
            addressValue = new TextDecoder().decode(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
            break;
        case 3:
            addressLength = 16;
            const ipv6 = [];
            const dataView = new DataView(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength).buffer);
            for (let i = 0; i < 8; i++) {
                ipv6.push(dataView.getUint16(i * 2).toString(16));
            }
            addressValue = ipv6.join(':');
            break;
        default:
            return { hasError: true };
    }

    return {
        hasError: false,
        addressRemote: addressValue,
        addressType,
        portRemote,
        rawDataIndex: addressValueIndex + addressLength,
        vlessVersion: version,
        isUDP,
    };
}

async function remoteSocketToWS(remoteSocket, webSocket, vlessResponseHeader, retry) {
    let hasIncomingData = false;

    try {
        await remoteSocket.readable.pipeTo(new WritableStream({
            async write(chunk) {
                if (webSocket.readyState !== WebSocket.OPEN) {
                    throw new Error('WebSocket is not open');
                }
                if (vlessResponseHeader) {
                    webSocket.send(new Blob([vlessResponseHeader, chunk]).arrayBuffer());
                    vlessResponseHeader = null;
                } else {
                    webSocket.send(chunk);
                }
                hasIncomingData = true;
            },
        }));
    } catch (error) {
        console.error('PipeTo error:', error);
        safeCloseWebSocket(webSocket);
    }

    if (!hasIncomingData && retry) {
        retry();
    }
}

function base64ToArrayBuffer(base64Str) {
    if (!base64Str) return { error: null };

    try {
        const decode = atob(base64Str.replace(/-/g, '+').replace(/_/g, '/'));
        return {
            earlyData: Uint8Array.from(decode, c => c.charCodeAt(0)),
            error: null,
        };
    } catch (error) {
        return { error };
    }
}

function isValidUUID(uuid) {
    const regex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    return regex.test(uuid);
}

const byteToHex = [];
for (let i = 0; i < 256; ++i) {
	byteToHex.push((i + 256).toString(16).slice(1));
}

function unsafeStringify(arr, offset = 0) {
	return (byteToHex[arr[offset + 0]] + byteToHex[arr[offset + 1]] + byteToHex[arr[offset + 2]] + byteToHex[arr[offset + 3]] + "-" + byteToHex[arr[offset + 4]] + byteToHex[arr[offset + 5]] + "-" + byteToHex[arr[offset + 6]] + byteToHex[arr[offset + 7]] + "-" + byteToHex[arr[offset + 8]] + byteToHex[arr[offset + 9]] + "-" + byteToHex[arr[offset + 10]] + byteToHex[arr[offset + 11]] + byteToHex[arr[offset + 12]] + byteToHex[arr[offset + 13]] + byteToHex[arr[offset + 14]] + byteToHex[arr[offset + 15]]).toLowerCase();
}

function stringify(arr, offset = 0) {
	const uuid = unsafeStringify(arr, offset);
	if (!isValidUUID(uuid)) {
		throw TypeError("Stringified UUID is invalid");
	}
	return uuid;
}

function safeCloseWebSocket(webSocket) {
    try {
        webSocket.close();
    } catch (error) {
        console.error('WebSocket close error:', error);
    }
}

async function handleUDPOutBound(webSocket, vlessResponseHeader) {
    const datagramSocket = connect({ hostname: '8.8.8.8', port: 53 });

    try {
        await datagramSocket.writeable.getWriter().write(vlessResponseHeader);
    } catch (error) {
        console.error('DatagramSocket write error:', error);
        return;
    }

    return {
        write: async chunk => {
            try {
                await datagramSocket.writeable.getWriter().write(chunk);
            } catch (error) {
                console.error('DatagramSocket chunk write error:', error);
                safeCloseWebSocket(webSocket);
            }
        },
    };
}

function getVLESSConfig(userID, hostName) {
	const vlessMain = `vless://${userID}\u0040${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}`
	return `
################################################################
v2ray
---------------------------------------------------------------
${vlessMain}
---------------------------------------------------------------
################################################################
`;
}
