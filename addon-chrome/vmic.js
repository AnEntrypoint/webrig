export const VMIC_INJECT = `(function() {
  if (window.__vmic_active) return
  window.__vmic_active = true
  const ctx = new AudioContext({ sampleRate: 48000 })
  ctx.resume().catch(() => {})
  const dest = ctx.createMediaStreamDestination()
  let nextTime = 0
  window.__vmic_push = function(f32Arr) {
    const buf = ctx.createBuffer(2, f32Arr.length / 2, 48000)
    const L = buf.getChannelData(0), R = buf.getChannelData(1)
    for (let i = 0; i < buf.length; i++) { L[i] = f32Arr[i * 2]; R[i] = f32Arr[i * 2 + 1] }
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.connect(dest)
    const now = ctx.currentTime
    if (nextTime < now) nextTime = now + 0.05
    src.start(nextTime)
    nextTime += buf.duration
  }
  const vmicStream = dest.stream
  const origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
  navigator.mediaDevices.getUserMedia = function(constraints) {
    if (!constraints || !constraints.audio) return origGUM(constraints)
    return ctx.resume().then(function() {
      return origGUM({ video: constraints.video || false, audio: false })
    }).then(function(s) {
      const as = new MediaStream([...vmicStream.getAudioTracks(), ...s.getVideoTracks()])
      return as
    }).catch(function() {
      return ctx.resume().then(function() {
        return new MediaStream(vmicStream.getAudioTracks())
      })
    })
  }
  const origEnum = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices)
  navigator.mediaDevices.enumerateDevices = function() {
    return origEnum().then(function(devices) {
      const hasVmic = devices.some(function(d) { return d.label === 'Discord Virtual Mic' })
      if (!hasVmic) {
        devices.unshift({ deviceId: 'vmic', groupId: 'vmic', kind: 'audioinput', label: 'Discord Virtual Mic', toJSON: function() { return this } })
      }
      return devices
    })
  }
  try { navigator.mediaDevices.dispatchEvent(new Event('devicechange')) } catch(_) {}
})()`

function f32ToBase64(f32Arr) {
  const bytes = new Uint8Array(f32Arr.buffer, f32Arr.byteOffset, f32Arr.byteLength)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

export function injectVmic(tabId, vmicState) {
  vmicState.injected = false
  chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression: VMIC_INJECT, awaitPromise: false }, () => {
    if (chrome.runtime.lastError) { console.warn('[bg] vmic inject failed:', chrome.runtime.lastError.message); return }
    console.log('[bg] vmic injected into tab', tabId)
    vmicState.injected = true
    const queued = vmicState.queue.splice(0)
    if (queued.length) console.log('[bg] flushing', queued.length, 'queued frames')
    queued.forEach((f32) => pushVmicFrame(tabId, f32))
  })
}

export function pushVmicFrame(tabId, f32Arr) {
  const b64 = f32ToBase64(f32Arr)
  const expr = `(function(){if(!window.__vmic_push)return;const b='${b64}',ab=Uint8Array.from(atob(b),c=>c.charCodeAt(0)).buffer;window.__vmic_push(new Float32Array(ab))})()`
  chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression: expr, awaitPromise: false }, () => {
    if (chrome.runtime.lastError) console.warn('[bg] vmic push failed:', chrome.runtime.lastError.message)
  })
}
