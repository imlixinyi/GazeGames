"""Local launcher: serves this folder on http://localhost (camera needs localhost/HTTPS)
and opens the experiment in the default browser. Close this window to stop the server."""
import http.server
import os
import socket
import sys
import threading
import webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))
os.chdir(ROOT)


class Handler(http.server.SimpleHTTPRequestHandler):
    # Windows sometimes maps .js to text/plain in the registry; force correct types.
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".js": "application/javascript", ".css": "text/css", ".json": "application/json",
                      ".html": "text/html", ".png": "image/png", ".svg": "image/svg+xml"}

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):  # keep the console quiet except for errors
        if args and str(args[1]).startswith(("4", "5")):
            super().log_message(fmt, *args)


def free_port():
    for port in range(5500, 5520):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    sys.exit("Ports 5500-5519 are all busy. Close other servers and try again.")


def main():
    port = free_port()
    page = sys.argv[1] if len(sys.argv) > 1 else "index.html"
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
    url = f"http://localhost:{port}/{page}"
    print("=" * 60)
    print(f" Experiment running at  {url}")
    print(f" Analysis page          http://localhost:{port}/analysis.html")
    print(f" Test without camera    http://localhost:{port}/index.html?sim=1")
    print(" Keep this window open. Close it (or press Ctrl+C) to stop.")
    print("=" * 60)
    threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
