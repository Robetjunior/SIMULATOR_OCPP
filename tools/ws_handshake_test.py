import base64
import os
import socket

def build_request(host, path, protocol):
    key = base64.b64encode(os.urandom(16)).decode()
    req = (
        f"GET {path} HTTP/1.1\r\n"
        f"Host: {host}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        f"Sec-WebSocket-Protocol: {protocol}\r\n"
        "Origin: http://localhost:5500\r\n"
        "\r\n"
    )
    return req

def parse_headers(resp):
    lines = resp.split("\r\n")
    status = lines[0]
    headers = {}
    for line in lines[1:]:
        if not line:
            break
        if ":" in line:
            k, v = line.split(":", 1)
            headers[k.strip().lower()] = v.strip()
    return status, headers

def test_ws(host="localhost", port=3000, path="/ocpp/CentralSystemService/LOCAL-CP-01", protocol="ocpp1.6"):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(5)
    s.connect((host, port))
    req = build_request(host, path, protocol)
    s.sendall(req.encode())
    resp = s.recv(4096).decode(errors="ignore")
    s.close()
    status, headers = parse_headers(resp)
    print(f"STATUS: {status}")
    print(f"PROTO: {headers.get('sec-websocket-protocol','')}\nCONN: {headers.get('connection','')}\nUPG: {headers.get('upgrade','')}")
    ok = status.startswith("HTTP/1.1 101") and headers.get("upgrade","" ).lower() == "websocket"
    if ok:
        print("RESULT: OK")
    else:
        print("RESULT: FAIL")
    return ok

if __name__ == "__main__":
    host = os.environ.get("WS_HOST", "localhost")
    port = int(os.environ.get("WS_PORT", "3000"))
    path = os.environ.get("WS_PATH", "/ocpp/CentralSystemService/LOCAL-CP-01")
    protocol = os.environ.get("WS_PROTOCOL", "ocpp1.6")
    test_ws(host, port, path, protocol)

