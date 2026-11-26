form x
  text name a_44100
  real n 12
endform
s = Read from file: "test/" + name$ + ".wav"
r = Resample: 48000, 1
m = Convert to mono
man = To Manipulation: 0.05, 60, 600
pt = Extract pitch tier
Formula: "32.703 * (2 ^ (" + string$(n) + "/12))"
selectObject: pt, man
Replace pitch tier
selectObject: man
out = Get resynthesis (overlap-add)
Save as WAV file: "ref/" + name$ + "_" + string$(n) + ".wav"
selectObject: m
Save as WAV file: "ref/" + name$ + "_mono.wav"
