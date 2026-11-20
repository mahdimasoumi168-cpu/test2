from pathlib import Path
import plistlib
import shutil

root = Path(__file__).resolve().parents[1]
platform = root / "platform"
manifest_src = platform / "AndroidManifest.xml"
manifest_dst = root / "android/app/src/main/AndroidManifest.xml"
manifest_dst.parent.mkdir(parents=True, exist_ok=True)
shutil.copy2(manifest_src, manifest_dst)

activity_dst = root / "android/app/src/main/kotlin/ir/heyat/hamyar_heyat/MainActivity.kt"
activity_dst.parent.mkdir(parents=True, exist_ok=True)
shutil.copy2(platform / "MainActivity.kt", activity_dst)

plist_path = root / "ios/Runner/Info.plist"
with plist_path.open("rb") as file:
    plist = plistlib.load(file)
plist["CFBundleDisplayName"] = "همیار هیئت"
plist["NSMicrophoneUsageDescription"] = "برای ارسال صدای شما هنگام نگه‌داشتن دکمه صحبت در اتاق هیئت."
modes = set(plist.get("UIBackgroundModes", []))
modes.add("audio")
plist["UIBackgroundModes"] = sorted(modes)
with plist_path.open("wb") as file:
    plistlib.dump(plist, file, sort_keys=False)

podfile = root / "ios/Podfile"
if podfile.exists():
    text = podfile.read_text()
    text = text.replace("platform :ios, '12.0'", "platform :ios, '13.0'")
    text = text.replace("platform :ios, '11.0'", "platform :ios, '13.0'")
    podfile.write_text(text)
