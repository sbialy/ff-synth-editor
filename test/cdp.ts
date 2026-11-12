// A minimal Chrome DevTools Protocol client over a WebSocket (no extra dependency), for the headless Chrome page tests.
export class Cdp {
  private id = 0
  private waiting = new Map<number, (v: any) => void>()
  constructor(private ws: WebSocket) {
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data))
      if (m.id && this.waiting.has(m.id)) { this.waiting.get(m.id)!(m); this.waiting.delete(m.id) }
    }
  }
  static async open(url: string) {
    const ws = new WebSocket(url)
    await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("cdp connect")) })
    return new Cdp(ws)
  }
  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    const id = ++this.id
    return new Promise((res, rej) => {
      this.waiting.set(id, (m) => (m.error ? rej(new Error(method + ": " + m.error.message)) : res(m.result)))
      this.ws.send(JSON.stringify({ id, method, params, sessionId }))
    })
  }
  close() { this.ws.close() }
}
