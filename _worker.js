import { connect } from 'cloudflare:sockets';

export default {
    async fetch(request, env) {
        try {
            const userID = env.UUID || 'd342d11e-d424-4583-b36e-524ab1f0afa4';
            const proxyIP = env.PROXYIP || '';
            const upgradeHeader = request.headers.get('Upgrade');
            const url = new URL(request.url);

            if (upgradeHeader === 'websocket') {
                return await vlessOverWSHandler(request, userID, proxyIP);
            }

            switch (url.pathname) {
                case '/':
                    return handleRootRequest(request);
                case `/${userID}`:
                    return handleVLESSConfigRequest(userID, request.headers.get('Host'));
                default:
                    return handleProxyRequest(request, url);
            }
        } catch (err) {
            return handleError(err);
        }
    },
};

async function handleRootRequest(request) {
    return new Response(JSON.stringify(request.cf, null, 4), { status: 200 });
}

function handleVLESSConfigRequest(userID, host) {
    return new Response(getVLESSConfig(userID, host), {
        status: 200,
        headers: { "Content-Type": "text/plain;charset=utf-8" }
    });
}

async function handleProxyRequest(request, url) {
    url.hostname = 'bing.com';
    url.protocol = 'https:';
    return await fetch(new Request(url, request));
}

function handleError(err) {
    return new Response(err.toString(), { status: 500 });
}

async function vlessOverWSHandler(request, userID, proxyIP) {
    const [client, webSocket] = new WebSocketPair();
    webSocket.accept();

    const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
    const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader);

    let address = '';
    let isDns = false;
    let udpStreamWrite = null;
    const remoteSocketWrapper = { value: null };

    const handleStream = async (chunk) => {
        if (isDns && udpStreamWrite) {
            udpStreamWrite(chunk);
            return;
        }
        if (remoteSocketWrapper.value) {
            await writeToRemoteSocket(remoteSocketWrapper.value, chunk);
            return;
        }

        const { hasError, addressRemote, portRemote, rawDataIndex, vlessVersion, isUDP } = processVlessHeader(chunk, userID);
        if (hasError) return;

        address = addressRemote;

        if (isUDP) {
            isDns = (portRemote === 53);
            if (!isDns) return;
        }

        const vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]);
        const rawClientData = chunk.slice(rawDataIndex);

        if (isDns) {
            udpStreamWrite = await setupUDPOutbound(webSocket, vlessResponseHeader);
            udpStreamWrite(rawClientData);
        } else {
            await setupTCPOutbound(remoteSocketWrapper, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, proxyIP);
        }
    };

    readableWebSocketStream.pipeTo(new WritableStream({ write: handleStream }));

    return new Response(null, { status: 101, webSocket: client });
}

async function writeToRemoteSocket(remoteSocket, chunk) {
    const writer = remoteSocket.writable.getWriter();
    await writer.write(chunk);
    writer.releaseLock();
}

async function setupUDPOutbound(webSocket, vlessResponseHeader) {
    const { write } = await handleUDPOutBound(webSocket, vlessResponseHeader);
    return write;
}

async function setupTCPOutbound(remoteSocketWrapper, address, port, rawClientData, webSocket, vlessResponseHeader, proxyIP) {
    await handleTCPOutBound(remoteSocketWrapper, address, port, rawClientData, webSocket, vlessResponseHeader, proxyIP);
}

async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, proxyIP) {
    async function connectAndWrite(address, port, data) {
        const tcpSocket = connect({ hostname: address, port });
        remoteSocket.value = tcpSocket;
        const writer = tcpSocket.writable.getWriter();
        await writer.write(data);
        writer.releaseLock();
        return tcpSocket;
    }

    async function handleRetry() {
        const addressToTry = proxyIP || addressRemote;
        const tcpSocket = await connectAndWrite(addressToTry, portRemote, rawClientData);
        tcpSocket.closed.catch(() => {}).finally(() => safeCloseWebSocket(webSocket));
        remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, null);
    }

    try {
        const tcpSocket = await connectAndWrite(addressRemote, portRemote, rawClientData);
        remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, handleRetry);
    } catch (error) {
        console.error('TCP outbound error:', error);
        safeCloseWebSocket(webSocket);
    }
}
function makeReadableWebSocketStream(webSocketServer, earlyDataHeader) {
    let isCancelled = false;

    const handleMessage = (event, controller) => {
        if (!isCancelled) {
            controller.enqueue(event.data);
        }
    };

    const handleClose = (controller) => {
        controller.close();
    };

    const handleError = (err, controller) => {
        controller.error(err);
    };

    const handleEarlyData = (controller) => {
        const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
        if (error) {
            controller.error(error);
        } else if (earlyData) {
            controller.enqueue(earlyData);
        }
    };

    return new ReadableStream({
        start(controller) {
            webSocketServer.addEventListener('message', event => handleMessage(event, controller));
            webSocketServer.addEventListener('close', () => handleClose(controller));
            webSocketServer.addEventListener('error', err => handleError(err, controller));
            handleEarlyData(controller);
        },
        cancel() {
            isCancelled = true;
            safeCloseWebSocket(webSocketServer);
        }
    });

function processVlessHeader(vlessBuffer, userID) {
    if (vlessBuffer.byteLength < 24) return { hasError: true };

    const version = new Uint8Array(vlessBuffer.slice(0, 1));
    if (!isValidUser(vlessBuffer.slice(1, 17), userID)) return { hasError: true };

    const optLength = vlessBuffer[17];
    const command = vlessBuffer[18 + optLength];
    if (![1, 2].includes(command)) return { hasError: true };

    const isUDP = (command === 2);
    const { portRemote, addressRemote, rawDataIndex } = parseAddressAndPort(vlessBuffer, 18 + optLength + 1);

    if (!addressRemote) return { hasError: true };

    return {
        hasError: false,
        addressRemote,
        portRemote,
        rawDataIndex,
        vlessVersion: version,
        isUDP
    };
}

function isValidUser(userBuffer, userID) {
    const userString = stringify(new Uint8Array(userBuffer));
    return userString === userID;
}

function parseAddressAndPort(buffer, startIndex) {
    const port = new DataView(buffer.slice(startIndex, startIndex + 2)).getUint16(0);
    const addressType = buffer[startIndex + 2];
    let addressLength = 0;
    let addressValue = '';
    let addressValueIndex = startIndex + 3;

    switch (addressType) {
        case 1:
            addressLength = 4;
            addressValue = Array.from(new Uint8Array(buffer.slice(addressValueIndex, addressValueIndex + addressLength)))
                                .join('.');
            break;
        case 2:
            addressLength = buffer[addressValueIndex];
            addressValueIndex += 1;
            addressValue = new TextDecoder().decode(buffer.slice(addressValueIndex, addressValueIndex + addressLength));
            break;
        case 3:
            addressLength = 16;
            addressValue = Array.from({ length: 8 }, (_, i) => {
                return new DataView(buffer.slice(addressValueIndex + i * 2, addressValueIndex + (i + 1) * 2)).getUint16(0).toString(16);
            }).join(':');
            break;
        default:
            return { portRemote: null, addressRemote: '', rawDataIndex: 0 };
    }

    return {
        portRemote: port,
        addressRemote: addressValue,
        rawDataIndex: addressValueIndex + addressLength
    };
}

async function remoteSocketToWS(remoteSocket, webSocket, vlessResponseHeader, retry) {
    let hasIncomingData = false;

    const handleWrite = async (chunk) => {
        hasIncomingData = true;
        if (webSocket.readyState !== WebSocket.OPEN) throw new Error('WebSocket is not open');
        
        const dataToSend = vlessResponseHeader ? await createBlobWithHeader(vlessResponseHeader, chunk) : chunk;
        webSocket.send(dataToSend);
        vlessResponseHeader = null;
    };

    try {
        await remoteSocket.readable.pipeTo(new WritableStream({ write: handleWrite }));
    } catch (error) {
        console.error('Error in remoteSocketToWS:', error);
        safeCloseWebSocket(webSocket);
    }

    if (!hasIncomingData && retry) {
        retry();
    }
}

async function createBlobWithHeader(header, chunk) {
    const blob = new Blob([header, chunk]);
    return await blob.arrayBuffer();
}

function base64ToArrayBuffer(base64Str) {
    if (!base64Str) return { earlyData: null, error: null };

    try {
        const sanitizedBase64 = sanitizeBase64(base64Str);
        const binaryString = atob(sanitizedBase64);
        const byteArray = Uint8Array.from(binaryString, char => char.charCodeAt(0));
        return { earlyData: byteArray.buffer, error: null };
    } catch (error) {
        return { earlyData: null, error };
    }
}

function sanitizeBase64(base64Str) {
    return base64Str
        .replace(/-/g, '+')
        .replace(/_/g, '/');
}

function safeCloseWebSocket(socket) {
    try {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CLOSING) {
            socket.close();
        }
    } catch (error) {
        console.error('Failed to close WebSocket:', error);
    }
}

function stringify(arr) {
    if (arr.length !== 16) {
        throw new Error('Array must be of length 16');
    }

    const byteToHex = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

    const hexString = arr.map(byte => byteToHex[byte]).join('');

    return `${hexString.slice(0, 8)}-${hexString.slice(8, 12)}-${hexString.slice(12, 16)}-${hexString.slice(16, 20)}-${hexString.slice(20)}`.toLowerCase();
}

async function handleUDPOutBound(webSocket, vlessResponseHeader) {
    let isVlessHeaderSent = false;

    const transformStream = new TransformStream({
        transform(chunk, controller) {
            let index = 0;
            while (index < chunk.byteLength) {
                const udpPacketLength = new DataView(chunk.slice(index, index + 2)).getUint16(0);
                controller.enqueue(chunk.slice(index + 2, index + 2 + udpPacketLength));
                index += 2 + udpPacketLength;
            }
        }
    });

    const writableStream = new WritableStream({
        async write(chunk) {
            const dnsQueryResult = await performDNSQuery(chunk);
            const udpSizeBuffer = createUDPSizeBuffer(dnsQueryResult.byteLength);

            if (webSocket.readyState === WebSocket.OPEN) {
                const blobParts = isVlessHeaderSent
                    ? [udpSizeBuffer, dnsQueryResult]
                    : [vlessResponseHeader, udpSizeBuffer, dnsQueryResult];
                webSocket.send(await new Blob(blobParts).arrayBuffer());
                isVlessHeaderSent = true;
            }
        }
    });

    transformStream.readable.pipeTo(writableStream);
    
    const writer = transformStream.writable.getWriter();
    await writer.write(chunk);
    writer.releaseLock();
}

async function performDNSQuery(chunk) {
    const response = await fetch('https://cloudflare-dns.com/dns-query', {
        method: 'POST',
        headers: { 'content-type': 'application/dns-message' },
        body: chunk
    });
    return response.arrayBuffer();
}

function createUDPSizeBuffer(size) {
    return new Uint8Array([(size >> 8) & 0xff, size & 0xff]);
}

function getVLESSConfig(userID, hostName) {
    return `
################################################################
---------------------------------------------------------------
vless://${userID}\u0040${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}
---------------------------------------------------------------
################################################################
`;
}
