#!/usr/bin/env python3
"""Output twelve frequency levels from the playback monitor. Never stores audio."""
import ctypes as C
import json
import math
import os
import sys

SIZE = 512
RATE = 16000
BANDS = 12


class Analyzer:
    def __init__(self):
        self.fft = C.CDLL('libfftw3f.so.3')
        self.samples = (C.c_float * SIZE)()
        self.output = (C.c_float * ((SIZE // 2 + 1) * 2))()
        self.fft.fftwf_plan_dft_r2c_1d.argtypes = [C.c_int, C.c_void_p, C.c_void_p, C.c_uint]
        self.fft.fftwf_plan_dft_r2c_1d.restype = C.c_void_p
        self.fft.fftwf_execute.argtypes = [C.c_void_p]
        self.fft.fftwf_destroy_plan.argtypes = [C.c_void_p]
        self.plan = self.fft.fftwf_plan_dft_r2c_1d(SIZE, self.samples, self.output, 64)
        if not self.plan:
            raise RuntimeError('FFT plan unavailable')
        self.window = [.5 - .5 * math.cos(2 * math.pi * n / (SIZE - 1)) for n in range(SIZE)]
        edges = [50 * (7500 / 50) ** (n / BANDS) for n in range(BANDS + 1)]
        self.ranges = [range(max(1, round(edges[n] * SIZE / RATE)),
                             max(2, round(edges[n] * SIZE / RATE) + 1, round(edges[n + 1] * SIZE / RATE)))
                       for n in range(BANDS)]

    def levels(self, pcm):
        for n in range(SIZE):
            self.samples[n] = pcm[n] * self.window[n]
        self.fft.fftwf_execute(self.plan)
        levels = []
        for bins in self.ranges:
            peak = max(math.hypot(self.output[k * 2], self.output[k * 2 + 1]) for k in bins) * 4 / SIZE
            db = 20 * math.log10(max(peak, 1e-8))
            levels.append(round(min(1, max(0, (db + 65) / 60)), 3))
        return levels

    def close(self):
        self.fft.fftwf_destroy_plan(self.plan)


class SampleSpec(C.Structure):
    _fields_ = [('format', C.c_int), ('rate', C.c_uint32), ('channels', C.c_uint8)]


class BufferAttr(C.Structure):
    _fields_ = [(name, C.c_uint32) for name in ('maxlength', 'tlength', 'prebuf', 'minreq', 'fragsize')]


def main():
    pulse = C.CDLL('libpulse.so.0')
    pulse.pa_parse_sample_format.argtypes = [C.c_char_p]
    pulse.pa_parse_sample_format.restype = C.c_int
    simple = C.CDLL('libpulse-simple.so.0')
    simple.pa_simple_new.argtypes = [C.c_char_p, C.c_char_p, C.c_int, C.c_char_p,
                                    C.c_char_p, C.c_void_p, C.c_void_p, C.c_void_p, C.c_void_p]
    simple.pa_simple_new.restype = C.c_void_p
    simple.pa_simple_read.argtypes = [C.c_void_p, C.c_void_p, C.c_size_t, C.c_void_p]
    simple.pa_simple_free.argtypes = [C.c_void_p]
    spec = SampleSpec(pulse.pa_parse_sample_format(b'float32le'), RATE, 1)
    attr = BufferAttr(0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff, SIZE * 4)
    error = C.c_int()
    # The optional monitor argument is for isolated loopback tests, never a mic default.
    device = os.getenv('AGENT_ISLAND_AUDIO_MONITOR', '@DEFAULT_MONITOR@').encode()
    stream = simple.pa_simple_new(None, b'Agent Island spectrum', 2, device,
                                  b'Playback visualization', C.byref(spec), None, C.byref(attr), C.byref(error))
    if not stream:
        return 1
    analyzer = Analyzer()
    pcm = (C.c_float * SIZE)()
    try:
        while simple.pa_simple_read(stream, pcm, C.sizeof(pcm), C.byref(error)) >= 0:
            print(json.dumps(analyzer.levels(pcm), separators=(',', ':')), flush=True)
    except BrokenPipeError:
        pass
    finally:
        analyzer.close()
        simple.pa_simple_free(stream)
    return 0


if __name__ == '__main__':
    sys.exit(main())
