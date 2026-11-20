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
    text = text.replace("platform :ios, '12.0'", "platform :ios, '16.0'")
    text = text.replace("platform :ios, '13.0'", "platform :ios, '16.0'")
    text = text.replace("platform :ios, '11.0'", "platform :ios, '16.0'")
    needle = "flutter_additional_ios_build_settings(target)"
    replacement = """flutter_additional_ios_build_settings(target)
      target.build_configurations.each do |config|
        config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '16.0'
        config.build_settings['ONLY_ACTIVE_ARCH'] = 'YES'
        config.build_settings['GCC_PREPROCESSOR_DEFINITIONS'] ||= ['$(inherited)']
        config.build_settings['GCC_PREPROCESSOR_DEFINITIONS'] << 'PERMISSION_MICROPHONE=1'
      end"""
    if needle in text and "ONLY_ACTIVE_ARCH" not in text:
        text = text.replace(needle, replacement)
    podfile.write_text(text)

for gradle_path in (root / "android/app/build.gradle.kts", root / "android/app/build.gradle"):
    if gradle_path.exists():
        gradle = gradle_path.read_text()
        gradle = gradle.replace("compileSdk = flutter.compileSdkVersion", "compileSdk = 37")
        gradle = gradle.replace("compileSdkVersion flutter.compileSdkVersion", "compileSdkVersion 37")
        gradle = gradle.replace("minSdk = flutter.minSdkVersion", "minSdk = 23")
        gradle = gradle.replace("minSdkVersion flutter.minSdkVersion", "minSdkVersion 23")
        gradle_path.write_text(gradle)
        break
