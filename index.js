var getMeta = require('./meta')
var slice = require('audiobuffer-slice')
var ebml = require('ebml') // DEBUG

module.exports = AudioBufferRangeDecoder

function AudioBufferRangeDecoder (filePath, options, onLoad) {
  var queue = []
  var meta = null
  var fd = null
  var fs = options.fs
  var lastOpenError = null

  var decode = function (startTime, duration, cb) {
    if (typeof cb !== 'function') {
      throw new Error('You must specify a callback')
    }

    if (!meta) {
      queue.push(arguments)
    } else {
      get(startTime, duration, cb)
    }
  }

  fs.open(filePath, 'r', function (err, res) {
    if (err) return openError(err)
    fd = res
    getMeta(fd, fs, function (err, value) {
      if (err) return openError(err)
      meta = value
      onLoad && onLoad(null, meta)
      while (queue.length) {
        get.apply(this, queue.shift())
      }
    })
  })

  decode.close = function () {
    if (fd != null) {
      fs.close(fd)
      fd = null
    }
  }

  return decode

  // scoped

  function openError (err) {
    lastOpenError = err
    onLoad && onLoad(err)

    while (queue.length) {
      get.apply(this, queue.shift())
    }
  }

  function get (startTime, duration, cb) {
    if (lastOpenError) {
      return cb(lastOpenError)
    }

    if (meta.type === 'webm') {
      handleWebm(meta, fd, options, startTime, duration, cb)
    } else {
      var offset = getOffset(meta, startTime, duration)
      var buffer = getBufferWithHeader(meta, offset[1])

      fs.read(fd, buffer, 44, offset[1], offset[0], function (err) {
        if (err) return cb && cb(err)
        var arrayBuffer = new Uint8Array(buffer).buffer
        options.audio.decodeAudioData(arrayBuffer, function (audioBuffer) {
          cb(null, audioBuffer)
        }, function (err) {
          cb(err || new Error('Decode error'))
        })
      })
    }
  }
}

function getOffset (meta, startTime, duration) {
  var fmt = meta.format
  var dataStart = meta.chunks.data[0]
  var startOffset = dataStart + align(fmt.byteRate * startTime, fmt.blockAlign)
  var length = align(fmt.byteRate * duration, fmt.blockAlign)
  return [startOffset, length]
}

function align (value, block) {
  return Math.floor(value / block) * block
}

function getBufferWithHeader (meta, length) {
  var buffer = new Buffer(44 + length)
  var format = meta.format

  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(44 + length, 4)
  buffer.write('WAVE', 8, 'ascii')

  // Format chunk
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(format.format, 20)
  buffer.writeUInt16LE(format.channels, 22)
  buffer.writeUInt32LE(format.sampleRate, 24)
  buffer.writeUInt32LE(format.byteRate, 28)
  buffer.writeUInt16LE(format.blockAlign, 32)
  buffer.writeUInt16LE(format.bitsPerSample, 34)

  // Data chunk header
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(length, 40)

  return buffer
}

function handleWebm (meta, fd, options, startTime, duration, cb) {
  var startMs = startTime * 1000
  var endMs = startMs + duration * 1000
  var cues = meta.cues.filter(function (cue, i) {
    return startMs <= cue[0] && cue[0] < endMs
  })

  var from = cues[0][1]
  var to = cues[cues.length - 1][2]
  var buffer = Buffer.alloc(meta.header.length + to - from)
  meta.header.copy(buffer, 0)

  var i = -1
  var start = meta.header.length
  var offset = cues[0][0]

  next()

  function next (err) {
    if (err) return cb(err)
    if (i >= 0) {
      buffer.writeInt16BE(cues[i][0] - offset, start + 1)
      start += cues[i][2] - cues[i][1]
    }
    i += 1
    if (i < cues.length) {
      var length = cues[i][2] - cues[i][1]
      options.fs.read(fd, buffer, start, length, cues[i][1], next)
    } else {
      end()
    }
  }

  function end () {
    decodeWebm(options.audio, buffer, function (err, audioBuffer) {
      if (err) return cb(err)
      var start = startMs - cues[0][0]
      audioBuffer = slice(audioBuffer, startMs - cues[0][0], start + endMs - startMs)
      cb(null, audioBuffer)
    })
  }
}
