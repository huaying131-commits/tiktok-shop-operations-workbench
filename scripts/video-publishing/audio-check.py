"""Offline signal + Whisper/Silero audit. Machine evidence is never human listening."""
import argparse, hashlib, json, math, shutil, subprocess, time
from pathlib import Path
from types import SimpleNamespace
import numpy as np
from faster_whisper import WhisperModel
from faster_whisper.vad import get_speech_timestamps, VadOptions

ap=argparse.ArgumentParser()
ap.add_argument('video');ap.add_argument('--output',required=True)
ap.add_argument('--model',default=r'C:\Users\Operator\.cache\huggingface\hub\models--Systran--faster-whisper-small\snapshots\536b0662742c02347bc0e980a01041f333bce120')
ap.add_argument('--expected-sha');args=ap.parse_args()
started=time.time();src=Path(args.video);sha=hashlib.sha256(src.read_bytes()).hexdigest()
if args.expected_sha and sha!=args.expected_sha:raise RuntimeError('Input SHA mismatch')
ffmpeg=shutil.which('ffmpeg');ffprobe=shutil.which('ffprobe')
if not ffmpeg or not ffprobe:raise RuntimeError('FFmpeg/ffprobe required')
def run(argv):return subprocess.run(argv,check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
probe=json.loads(run([ffprobe,'-v','error','-show_streams','-of','json',str(src)]).stdout)
audio=[x for x in probe['streams'] if x['codec_type']=='audio']
if not audio:raise RuntimeError('No audio stream')
rate=int(audio[0]['sample_rate']);channels=int(audio[0]['channels'])
pcm=np.frombuffer(run([ffmpeg,'-v','error','-threads','1','-i',str(src),'-vn','-f','f32le','-acodec','pcm_f32le','-']).stdout,dtype='<f4').reshape(-1,channels)
mono=np.frombuffer(run([ffmpeg,'-v','error','-threads','1','-i',str(src),'-vn','-ac','1','-ar','16000','-f','f32le','-acodec','pcm_f32le','-']).stdout,dtype='<f4').copy()
peak=float(np.max(np.abs(pcm)));rms=float(np.sqrt(np.mean(pcm.astype(np.float64)**2)));db=lambda x:20*math.log10(max(x,1e-12))
frame=max(1,int(rate*.02));trim=pcm[:len(pcm)//frame*frame];energy=np.sqrt(np.mean(trim.reshape(-1,frame,channels).astype(np.float64)**2,axis=(1,2)));silent=energy<10**(-40/20)
intervals=[];begin=None
for k,is_silent in enumerate(list(silent)+[False]):
    if is_silent and begin is None:begin=k
    if not is_silent and begin is not None:
        if (k-begin)*.02>=.5:intervals.append({'start':round(begin*.02,3),'end':round(k*.02,3)})
        begin=None
vad=get_speech_timestamps(mono,VadOptions(min_silence_duration_ms=250))
speech=[{'start':round(x['start']/16000,3),'end':round(x['end']/16000,3)} for x in vad]
if speech:
    model=WhisperModel(args.model,device='cpu',compute_type='int8',cpu_threads=2,local_files_only=True)
    segments,info=model.transcribe(mono,beam_size=3,word_timestamps=True,vad_filter=True,condition_on_previous_text=False)
    rows=[{'start':s.start,'end':s.end,'text':s.text,'avg_logprob':s.avg_logprob,'no_speech_prob':s.no_speech_prob,'words':[{'start':w.start,'end':w.end,'word':w.word,'probability':w.probability} for w in (s.words or [])]} for s in segments]
else:
    rows=[];info=SimpleNamespace(language=None,language_probability=0.0)
clip=float(np.mean(np.abs(pcm)>=.999));duration=len(pcm)/rate;flags=[]
if peak<.01:flags.append('very_low_signal')
if clip>.001:flags.append('possible_clipping_over_0.1_percent_samples')
if not rows:flags.append('no_speech_transcribed')
if not speech:flags.append('VAD_detected_no_speech')
if sum(bool(x) for x in silent)/max(len(silent),1)>.8:flags.append('mostly_silent_under_minus40dBFS')
if any(x['end']-x['start']>1.5 and x['start']>.5 and x['end']<duration-.5 for x in intervals):flags.append('long_internal_silence_review')
if any(s['avg_logprob']<-.8 for s in rows):flags.append('low_ASR_confidence_review')
result={'schema':'audio-check/v1','video':str(src.resolve()),'sha256':sha,'status':'machine_audio_audit_complete','human_listening':False,'model_audio_reasoning':False,'auto_publish_approval':False,'signal':{'sample_rate':rate,'channels':channels,'duration':duration,'peak_dBFS':round(db(peak),2),'rms_dBFS':round(db(rms),2),'near_full_scale_fraction':clip,'silence_threshold_dBFS':-40,'long_silences':intervals},'speech_VAD':speech,'ASR':{'engine':'faster-whisper','model_local_path':args.model,'language':info.language,'language_probability':info.language_probability,'text':' '.join(x['text'].strip() for x in rows),'segments':rows},'review_flags':flags,'limits':['Transcription is not a naturalness, pronunciation or semantic-listening approval.','Signal/VAD thresholds are review flags, not proof of quality.','No waveform modification, cloud upload, model download or paid API.'],'sources':['https://github.com/SYSTRAN/faster-whisper','https://github.com/SYSTRAN/faster-whisper/blob/master/faster_whisper/vad.py'],'elapsed_seconds':round(time.time()-started,2)}
out=Path(args.output);out.parent.mkdir(parents=True,exist_ok=True);out.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8')
print(json.dumps({'output':str(out.resolve()),'status':result['status'],'sha256':sha,'review_flags':flags,'language':info.language,'text':result['ASR']['text'],'seconds':result['elapsed_seconds']},ensure_ascii=False))
