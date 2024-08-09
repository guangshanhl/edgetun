import { connect } from 'cloudflare:sockets';
let userID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
let proxyIP = '';
function isValidUUID(uuid) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid);
}
if (!isValidUUID(userID)) throw new Error('uuid is not valid');
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
            return new Response(JSON.stringify(request.cf, null, 4), {
              status: 200
            });
          case `/${userID}`:
            return new Response(getVLESSConfig(userID, request.headers.get('Host')), {
              status: 200,
              headers: {
                "Content-Type": "text/plain;charset=utf-8",
                "Alt-Svc": 'h3-23=":443"; ma=86400, h3-22=":443"; ma=86400, h3-21=":443"; ma=86400'
              }
            });
          default:
            return new Response('Not found', {
              status: 404
            });
        }
      } else {
        return await vlessOverWSHandler(request);
      }
    } catch (err) {
      return new Response(err.toString());
    }
  }
};
async function vlessOverWSHandler(request) {
  const {
    0: client,
    1: webSocket
  } = new WebSocketPair();
  webSocket.accept();
  const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
  const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader);
  let remoteSocketWapper = {
    value: null
  };
  let udpStreamWrite = null;
  let isDns = false;
  readableWebSocketStream.pipeTo(new WritableStream({
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
      const {
        hasError,
        addressRemote,
        portRemote,
        rawDataIndex,
        vlessVersion,
        isUDP
      } = processVlessHeader(chunk, userID);
      if (hasError) return;
      if (isUDP && portRemote === 53) {
        isDns = true;
      } else if (!isUDP) {
        handleTCPOutBound(remoteSocketWapper, addressRemote, portRemote, chunk.slice(rawDataIndex), webSocket, new Uint8Array([vlessVersion[0], 0]));
        return;
      }
      if (isDns) {
        const {
          write
        } = await handleUDPOutBound(webSocket, new Uint8Array([vlessVersion[0], 0]));
        udpStreamWrite = write;
        udpStreamWrite(chunk.slice(rawDataIndex));
      }
    }
  })).catch(error => {});
  return new Response(null, {
    status: 101,
    webSocket: client
  });
}
async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader) {
  const connectAndWrite = async (address, port) => {
    if (remoteSocket.value && !remoteSocket.value.closed) {
      const writer = remoteSocket.value.writable.getWriter();
      await writer.write(rawClientData);
      writer.releaseLock();
      return remoteSocket.value;
    } else {
      const quicSocket = connect({
        hostname: address,
        port,
        protocol: 'quic'
      });
      remoteSocket.value = quicSocket;
      const writer = quicSocket.writable.getWriter();
      await writer.write(rawClientData);
      writer.releaseLock();
      return quicSocket;
    }
  };
  const quicSocket = await connectAndWrite(addressRemote, portRemote);
  remoteSocketToWS(quicSocket, webSocket, vlessResponseHeader, async () => {
    const fallbackSocket = await connectAndWrite(proxyIP || addressRemote, portRemote);
    fallbackSocket.closed.catch(() => {}).finally(() => safeCloseWebSocket(webSocket));
    remoteSocketToWS(fallbackSocket, webSocket, vlessResponseHeader);
  });
}
function makeReadableWebSocketStream(webSocketServer, earlyDataHeader) {
  const stream = new ReadableStream({
    start(controller) {
      webSocketServer.addEventListener('message', event => controller.enqueue(event.data));
      webSocketServer.addEventListener('close', () => controller.close());
      webSocketServer.addEventListener('error', err => controller.error(err));
      const {
        earlyData,
        error
      } = base64ToArrayBuffer(earlyDataHeader);
      if (error) {
        controller.error(error);
      } else if (earlyData) {
        controller.enqueue(earlyData);
      }
    },
    cancel() {
      safeCloseWebSocket(webSocketServer);
    }
  });
  return stream;
}
function processVlessHeader(vlessBuffer, userID) {
  if (vlessBuffer.byteLength < 24) return {
    hasError: true
  };
  const view = new DataView(vlessBuffer);
  const version = vlessBuffer.slice(0, 1);
  const userIDBuffer = new Uint8Array(vlessBuffer.slice(1, 17));
  if (stringify(userIDBuffer) !== userID) return {
    hasError: true
  };
  const optLength = view.getUint8(17);
  const command = view.getUint8(18 + optLength);
  if (command !== 1 && command !== 2) return {
    hasError: true
  };
  const isUDP = command === 2;
  const portIndex = 18 + optLength + 1;
  const portRemote = view.getUint16(portIndex);
  const addressIndex = portIndex + 2;
  const addressType = view.getUint8(addressIndex);
  let addressRemote = '';
  let addressLength = 0;
  let addressValueIndex = addressIndex + 1;
  switch (addressType) {
    case 1:
      addressLength = 4;
      addressRemote = `${view.getUint8(addressValueIndex)}.${view.getUint8(addressValueIndex + 1)}.${view.getUint8(addressValueIndex + 2)}.${view.getUint8(addressValueIndex + 3)}`;
      break;
    case 2:
      addressLength = view.getUint8(addressValueIndex);
      addressValueIndex += 1;
      addressRemote = new TextDecoder().decode(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
      break;
    case 3:
      addressLength = 16;
      const ipv6 = [];
      for (let i = 0; i < 8; i++) {
        ipv6.push(view.getUint16(addressValueIndex + i * 2).toString(16).padStart(4, '0'));
      }
      addressRemote = ipv6.join(':');
      break;
    default:
      return {
        hasError: true
      };
  }
  return {
    hasError: false,
    addressRemote,
    portRemote,
    rawDataIndex: addressValueIndex + addressLength,
    vlessVersion: version,
    isUDP
  };
}
async function remoteSocketToWS(remoteSocket, webSocket, vlessResponseHeader, retry) {
  let hasIncomingData = false;
  let vlessHeader = vlessResponseHeader;
  try {
    await remoteSocket.readable.pipeTo(new WritableStream({
      async write(chunk) {
        hasIncomingData = true;
        if (webSocket.readyState === WebSocket.OPEN) {
          if (vlessHeader) {
            webSocket.send(await new Blob([vlessHeader, chunk]).arrayBuffer());
            vlessHeader = null;
          } else {
            webSocket.send(chunk);
          }
        }
      }
    }));
  } catch (error) {
    safeCloseWebSocket(webSocket);
  }
  if (!hasIncomingData && retry) retry();
}
function base64ToArrayBuffer(base64Str) {
  if (!base64Str) {
    return {
      error: null
    };
  }
  try {
    base64Str = base64Str.replace(/-/g, '+').replace(/_/g, '/');
    const decode = atob(base64Str);
    const arryBuffer = Uint8Array.from(decode, c => c.charCodeAt(0));
    return {
      earlyData: arryBuffer.buffer,
      error: null
    };
  } catch (error) {
    return {
      error
    };
  }
}
function safeCloseWebSocket(socket) {
  try {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CLOSING) {
      socket.close();
    }
  } catch (error) {}
}
const byteToHex = Array.from({
  length: 256
}, (_, i) => (i + 256).toString(16).slice(1));
function unsafeStringify(arr, offset = 0) {
  const segments = [4, 2, 2, 2, 6];
  let result = '';
  let index = offset;
  segments.forEach((len, i) => {
    for (let j = 0; j < len; j++) {
      result += byteToHex[arr[index++]];
    }
    if (i < segments.length - 1) result += '-';
  });
  return result.toLowerCase();
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
  const quicClient = new QUIC({
    remoteAddress: "8.8.8.8",
    remotePort: 443
  });
  await quicClient.connect();
  const udpSizeBuffer = new Uint8Array(2);
  quicClient.on('data', data => {
    const udpSize = data.byteLength;
    udpSizeBuffer[0] = udpSize >> 8 & 0xff;
    udpSizeBuffer[1] = udpSize & 0xff;
    if (webSocket.readyState === WebSocket.OPEN) {
      if (isVlessHeaderSent) {
        webSocket.send(new Blob([udpSizeBuffer, data]).arrayBuffer());
      } else {
        const headerData = [vlessResponseHeader, udpSizeBuffer, data];
        webSocket.send(new Blob(headerData).arrayBuffer());
        isVlessHeaderSent = true;
      }
    }
  });
  const writer = quicClient.writable.getWriter();
  return {
    write: chunk => writer.write(chunk)
  };
}
function getVLESSConfig(userID, hostName) {
  return `
vless://${userID}\u0040${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}`;
}
