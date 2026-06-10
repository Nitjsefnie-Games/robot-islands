#!/usr/bin/env python3
"""Launch headless chromium, load Robot Islands, inject the live save, capture
a 25s V8 CPU profile via CDP, and dump it to /tmp/ri-browser-profile.json.

Requires: chromium, python websocket-client.
"""
import json, os, subprocess, sys, tempfile, time, urllib.request
import websocket

URL = 'https://islands.nitjsefni.eu/'
SAVE_PATH = sys.argv[1] if len(sys.argv) > 1 else '/tmp/robot-islands-save.json'
PROFILE_SECONDS = int(os.environ.get('PROFILE_SECONDS', '25'))
DEBUG_PORT = 9223  # avoid clashing with anything on 9222
OUT_PROFILE = '/tmp/ri-browser-profile.json'

# 1. Launch headless chromium
profile_dir = tempfile.mkdtemp(prefix='chromium-ri-')
chrome_proc = subprocess.Popen([
    '/usr/bin/chromium',
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--use-gl=swiftshader',
    '--enable-unsafe-swiftshader',
    f'--remote-debugging-port={DEBUG_PORT}',
    '--remote-allow-origins=*',
    f'--user-data-dir={profile_dir}',
    '--disable-dev-shm-usage',
    '--window-size=1280,720',
    URL,
], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

print(f'chromium launched, pid={chrome_proc.pid}, profile-dir={profile_dir}')

# Wait for the debugger HTTP endpoint to come up
ws_url = None
for _ in range(40):
    time.sleep(0.5)
    try:
        with urllib.request.urlopen(f'http://localhost:{DEBUG_PORT}/json', timeout=2) as r:
            tabs = json.loads(r.read())
        for t in tabs:
            if t.get('type') == 'page' and 'islands.nitjsefni.eu' in (t.get('url') or ''):
                ws_url = t.get('webSocketDebuggerUrl')
                break
        if ws_url:
            break
    except Exception:
        pass

if not ws_url:
    print('FAIL: could not find page tab via /json after 20s')
    chrome_proc.terminate()
    sys.exit(1)

print(f'page WS: {ws_url[:80]}...')

# 2. Open CDP, wait for page-load
ws = websocket.create_connection(ws_url, timeout=30)
ws.settimeout(45)

msg_id = [0]
def call(method, params=None):
    msg_id[0] += 1
    mid = msg_id[0]
    msg = {'id': mid, 'method': method}
    if params is not None:
        msg['params'] = params
    ws.send(json.dumps(msg))
    while True:
        raw = ws.recv()
        r = json.loads(raw)
        if r.get('id') == mid:
            if 'error' in r:
                print(f'CDP error on {method}: {r["error"]}')
                return None
            return r.get('result')

# Wait until the document is loaded
call('Page.enable')
call('Runtime.enable')
print('waiting for document...')
for _ in range(30):
    state = call('Runtime.evaluate', {'expression': 'document.readyState'})
    if state and state.get('result', {}).get('value') == 'complete':
        break
    time.sleep(0.5)
print(f'document ready: {state["result"]["value"] if state else "?"}')

# 3. Inject the save into IDB
with open(SAVE_PATH) as f:
    save_blob = f.read()
print(f'save size: {len(save_blob)} bytes')

# Use a global variable + reload trick — set the save in a window prop and have a script load it into IDB.
inject_js = '''
(async () => {
  const save = JSON.parse(window.__RI_SAVE__);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('keyval-store', 1);
    req.onupgradeneeded = (ev) => {
      const db = ev.target.result;
      if (!db.objectStoreNames.contains('keyval')) {
        db.createObjectStore('keyval');
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('keyval', 'readwrite');
      const store = tx.objectStore('keyval');
      const key = `robot-islands:save:v${save.v}`;
      store.put(save, key);
      tx.oncomplete = () => resolve({key, v: save.v});
      tx.onerror = () => reject(tx.error?.message ?? 'tx-error');
    };
    req.onerror = () => reject(req.error?.message ?? 'open-error');
  });
})()
'''
# Set the save string as a window var so JSON parsing happens inside the page, avoiding 27MB args
set_var = call('Runtime.evaluate', {
    'expression': f'window.__RI_SAVE__ = ' + json.dumps(save_blob) + '; "ok"',
    'returnByValue': True,
})
print(f'save var set: {set_var}')

inject_res = call('Runtime.evaluate', {
    'expression': inject_js,
    'awaitPromise': True,
    'returnByValue': True,
})
print(f'IDB inject: {inject_res}')

# 4. Reload so the engine deserializes the save
call('Page.reload')
print('reloading to deserialize save...')
for _ in range(30):
    state = call('Runtime.evaluate', {'expression': 'document.readyState'})
    if state and state.get('result', {}).get('value') == 'complete':
        break
    time.sleep(0.5)
time.sleep(4)  # let the engine spin up + render a few frames

# 5. Profile
call('Profiler.enable')
call('Profiler.setSamplingInterval', {'interval': 200})
start = call('Profiler.start')
print(f'profile started, sampling {PROFILE_SECONDS}s...')
time.sleep(PROFILE_SECONDS)
stop = call('Profiler.stop')
if not stop:
    print('FAIL: Profiler.stop returned None')
    ws.close()
    chrome_proc.terminate()
    sys.exit(1)

profile = stop['profile']
with open(OUT_PROFILE, 'w') as f:
    json.dump(profile, f)
print(f'profile saved to {OUT_PROFILE} ({os.path.getsize(OUT_PROFILE)} bytes)')

# Some FPS / metrics
metrics = call('Performance.getMetrics')
if metrics:
    print('--- Performance.getMetrics ---')
    for m in metrics.get('metrics', []):
        print(f'  {m["name"]}: {m["value"]}')

ws.close()
chrome_proc.terminate()
chrome_proc.wait(timeout=10)
print('done.')
