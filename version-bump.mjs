import { readFileSync, writeFileSync } from "fs";

const targetVersion = process.argv[2];
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const versions = JSON.parse(readFileSync("versions.json", "utf8"));

const { minAppVersion } = manifest;
const currentVersion = manifest.version;

if (targetVersion && targetVersion !== currentVersion) {
    manifest.version = targetVersion;
    versions[targetVersion] = minAppVersion;
    writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t"));
    writeFileSync("versions.json", JSON.stringify(versions, null, "\t"));
    console.log(`Version updated from ${currentVersion} to ${targetVersion}`);
} else {
    console.log(`Current version is ${currentVersion}`);
}
