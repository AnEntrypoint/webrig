const FRAME_SAMPLES = 960

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this._buf = new Float32Array(FRAME_SAMPLES * 2)
    this._pos = 0
  }

  process(inputs) {
    const input = inputs[0]
    if (!input || !input[0]) return true
    const L = input[0], R = input[1] || input[0]
    for (let i = 0; i < L.length; i++) {
      this._buf[this._pos++] = L[i]
      this._buf[this._pos++] = R[i]
      if (this._pos >= FRAME_SAMPLES * 2) {
        const frame = this._buf.slice()
        this.port.postMessage(frame.buffer, [frame.buffer])
        this._buf = new Float32Array(FRAME_SAMPLES * 2)
        this._pos = 0
      }
    }
    return true
  }
}
registerProcessor('capture-processor', CaptureProcessor)
