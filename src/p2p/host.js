import { sendFrame } from './swarm.js'

function broadcastFrame(buf) {
  sendFrame(buf)
}

export { broadcastFrame }
