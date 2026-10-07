# stdio JSON 协议服务器：每行一个请求 → 每行一个响应
import json
import sys
import traceback

from . import __version__, SYNTH_VERSION, METRICS_VERSION, ENV_VERSION, MIX_VERSION
from . import env as envmod
from . import metrics as mmod
from . import mix as mixmod
from . import synth as synthmod
from . import wavio
import numpy as np


def _require(req: dict, key: str):
    if key not in req:
        raise ValueError(f'缺少参数 {key}')
    return req[key]


def dispatch(req: dict) -> dict:
    cmd = req.get('cmd') or ''
    if cmd == 'ping':
        import scipy
        import PIL
        return {
            'version': __version__,
            'versions': {'synth': SYNTH_VERSION, 'metrics': METRICS_VERSION, 'env': ENV_VERSION, 'mix': MIX_VERSION},
            'numpy': np.__version__,
            'scipy': scipy.__version__,
            'pil': PIL.__version__,
        }

    if cmd == 'env':
        x, sr = wavio.read_wav(_require(req, 'music'))
        mono = wavio.to_mono(x)
        data = envmod.compute_env(mono, sr, float(req.get('fps', 60)), int(_require(req, 'nframes')))
        out = req.get('out')
        if out:
            with open(out, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False)
            return {'out': out, 'max': data['max'], 'mean': data['mean'], 'nframes': data['nframes'], 'values': None}
        return data

    if cmd == 'sfx_track':
        events = _require(req, 'events')
        sr = int(req.get('sr', 48000))
        duration = float(_require(req, 'duration'))
        seed = int(req.get('seed', 7))
        bus_gains = req.get('busGains') or {}
        tail_fade = float(req.get('tailFade') or mixmod.TAIL_FADE)
        track = mixmod.build_sfx_track(events, sr, duration, seed=seed, bus_gains=bus_gains, tail_fade=tail_fade)
        out = _require(req, 'out')
        info = wavio.write_wav(out, track, sr)
        return {'file': out, **info}

    if cmd == 'mix':
        info = mixmod.run_mix(
            music_path=req.get('music'),
            duration=float(_require(req, 'duration')),
            out=_require(req, 'out'),
            sfx_path=req.get('sfxPath'),
            gain=float(req.get('gain', 1.0)),
            fade_out=req.get('fadeOut'),
            cut_from=req.get('cutFrom'),
            limit_dbfs=float(req.get('limitDbfs', -1.0)),
            sr=int(req.get('sr', 48000)),
        )
        return info

    if cmd == 'audio_stats':
        x, sr = wavio.read_wav(_require(req, 'wav'))
        mono = wavio.to_mono(x)
        return mixmod.audio_stats(mono, sr, window=float(req.get('window', 0.1)))

    if cmd == 'window_levels':
        x, sr = wavio.read_wav(_require(req, 'wav'))
        mono = wavio.to_mono(x)
        return {'levels': mixmod.window_levels(mono, sr, _require(req, 'windows'))}

    if cmd == 'beats':
        x, sr = wavio.read_wav(_require(req, 'wav'))
        mono = wavio.to_mono(x)
        return envmod.detect_beats(mono, sr, fps=float(req.get('fps', 60.0)))

    if cmd == 'synth_preview':
        # 合成单条音效并落盘（调试/试听用）
        x = synthmod.synth(_require(req, 'sfx'), int(req.get('sr', 48000)), req.get('params') or {}, seed=int(req.get('seed', 7)))
        out = _require(req, 'out')
        info = wavio.write_wav(out, x, int(req.get('sr', 48000)))
        return {'file': out, **info}

    if cmd == 'density':
        return mmod.density(_require(req, 'png'), lit=float(req.get('lit', 40.0)))

    if cmd == 'frame_diff':
        return mmod.frame_diff(_require(req, 'a'), _require(req, 'b'), eps=float(req.get('eps', 8.0)))

    if cmd == 'edge_band':
        return mmod.edge_band(_require(req, 'png'), band=int(req.get('band', 34)), lit=float(req.get('lit', 40.0)))

    if cmd == 'black_level':
        return mmod.black_level(_require(req, 'png'))

    if cmd == 'transition_spike':
        return mmod.transition_spike(_require(req, 'pngs'), eps=float(req.get('eps', 8.0)), factor=float(req.get('factor', 2.2)))

    if cmd == 'montage':
        return mmod.montage(_require(req, 'pngs'), _require(req, 'out'), cols=int(req.get('cols', 3)), cell=int(req.get('cell', 320)), labels=req.get('labels'))

    if cmd == 'grid_overlay':
        return mmod.grid_overlay(_require(req, 'png'), _require(req, 'out'), highlights=req.get('highlights'))

    if cmd == 'density_batch':
        return {'items': [mmod.density(p) for p in _require(req, 'pngs')]}

    raise ValueError(f'未知命令：{cmd}')


def main() -> None:
    try:
        sys.stdin.reconfigure(encoding='utf-8')
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        rid = None
        try:
            req = json.loads(line)
            rid = req.get('id')
            data = dispatch(req)
            resp = {'id': rid, 'ok': True, 'data': data}
        except Exception as e:
            resp = {
                'id': rid,
                'ok': False,
                'error': {
                    'code': 'E-PY-001',
                    'message': str(e),
                    'trace': traceback.format_exc(limit=3) if __debug__ else None,
                },
            }
        sys.stdout.write(json.dumps(resp, ensure_ascii=False, separators=(',', ':')) + '\n')
        sys.stdout.flush()


if __name__ == '__main__':
    main()
