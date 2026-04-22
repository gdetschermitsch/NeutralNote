class RecorderProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0] && input[0].length) {
      const channel = input[0];
      this.port.postMessage(channel.slice());
    }
    return true;
  }
}

registerProcessor('recorder-processor', RecorderProcessor);
