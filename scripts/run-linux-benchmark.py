"""Run the disposable Linux fixture through authenticated Railway SSH; never deploys.

Example: python3 scripts/run-linux-benchmark.py --project ID --environment ID
  --service ID --label after --output /absolute/evidence --patch dist/desktop-viewer.js
Read cgroup memory/process headroom before running this one-Chrome benchmark.
"""
import argparse
import base64
import json
import pathlib
import shlex
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
for name in ("project", "environment", "service", "label", "output"):
    parser.add_argument("--" + name, required=True)
parser.add_argument("--patch", action="append", default=[])
parser.add_argument("--jitter", action="store_true", help="Use a fixed inter-action delay sequence to vary clicks within frame cadence.")
args = parser.parse_args()
out = pathlib.Path(args.output).resolve()
out.mkdir(parents=True, exist_ok=True)
script = pathlib.Path(__file__).with_name("benchmark-linux.mjs").read_bytes()
encoded = base64.b64encode(script).decode()
patches = []
for value in args.patch:
    file = pathlib.Path(value)
    if file.name not in ("desktop-viewer.js", "x11-remote.js"):
        parser.error("Only the reviewed capture modules may be overlaid.")
    patches.append({"name": file.name, "data": base64.b64encode(file.read_bytes()).decode()})
bootstrap = "const fs=await import('node:fs');let patchDir,fixtureDir;"
bootstrap += "const mem=Number(fs.readFileSync('/sys/fs/cgroup/memory.current','utf8'));const max=Number(fs.readFileSync('/sys/fs/cgroup/memory.max','utf8'));if(Number.isFinite(max)&&max-mem<536870912)throw new Error('Less than 512 MiB container headroom; benchmark not started');"
bootstrap += "process.env.AUDIT_LABEL=" + json.dumps(args.label) + ";"
if args.jitter:
    bootstrap += "process.env.AUDIT_JITTER='1';"
bootstrap += "try{fixtureDir=fs.mkdtempSync('/tmp/tallylamp-linux-audit-');process.env.AUDIT_DIRECTORY=fixtureDir;"
if patches:
    bootstrap += "patchDir=fs.mkdtempSync('/tmp/tallylamp-audit-patch-');process.env.AUDIT_PATCH_DIR=patchDir;"
    bootstrap += "for(const p of " + json.dumps(patches) + "){fs.writeFileSync(patchDir+'/'+p.name,Buffer.from(p.data,'base64'));}"
bootstrap += "await import('data:text/javascript;base64," + encoded + "');"
bootstrap += "}finally{if(patchDir)fs.rmSync(patchDir,{recursive:true,force:true});if(fixtureDir)fs.rmSync(fixtureDir,{recursive:true,force:true})}"
command = "node --max-old-space-size=256 --input-type=module -e " + shlex.quote(bootstrap)
try:
    result = subprocess.run(["railway", "ssh", "--project", args.project,
        "--environment", args.environment, "--service", args.service, "--", command],
        capture_output=True, text=True, timeout=150)
except subprocess.TimeoutExpired as error:
    (out / ("linux-" + args.label + ".failure.txt")).write_text("SSH exceeded 150 seconds. Inspect remote owned processes before continuing.\n")
    raise SystemExit("SSH timeout; do not rerun before checking remote cleanup.") from error
(out / ("linux-" + args.label + ".log")).write_text(result.stdout + "\n" + result.stderr)
reports = [line.removeprefix("AUDIT_REPORT ") for line in result.stdout.splitlines() if line.startswith("AUDIT_REPORT ")]
if not reports:
    print("\n".join(line for line in (result.stdout + "\n" + result.stderr).splitlines() if len(line) < 1000)[-3000:])
    raise SystemExit(result.returncode or 1)
report = json.loads(reports[-1])
picture = report.pop("firstDesktopFrameBase64", None)
if picture:
    (out / ("linux-" + args.label + "-desktop.jpg")).write_bytes(base64.b64decode(picture))
target = out / ("linux-" + args.label + ".json")
temporary = target.with_suffix(".json.tmp")
temporary.write_text(json.dumps(report, indent=2) + "\n")
temporary.replace(target)
print(json.dumps({"results": [{k:v for k,v in row.items() if k != "samplesMs"} for row in report["results"]], "failures":report["failures"], "exit":result.returncode}, indent=2))
raise SystemExit(result.returncode)
