# Native decoder compatibility and external acceptance gate

The wrapper is Windows x64 C++17 and references the official [SDK Guide](https://docs.nvidia.com/nsight-aftermath/SDK/index.html) and [NVIDIA D3D12 sample](https://github.com/NVIDIA/nsight-aftermath-samples/tree/master/D3D12HelloNsightAftermath). The current sample documents SDK **2026.3 or newer**; use matching headers/import library/runtime from your licensed local SDK. Compilation and runtime startup have been verified against the supplied local SDK; real dump decoding remains a separate pending gate.

The wrapper calls CreateDecoder, GenerateJSON, GetJSON, DestroyDecoder and the SDK identifier/hash APIs for shader lookup. It never scans dump strings. Full raw JSON is retained separately from the versioned normalized observations. D3D DXIL/cso/bin shader binaries and NVIDIA .nvdbg files are indexed by SDK-defined binary/debug identifiers, not guessed filenames. Source callbacks use debug names queried from full shader blobs. Separate PDB-named shader debug files and SPIR-V indexing are not supported in the initial wrapper. PDBs for CPU executables are not GPU shader debug artifacts.

Install Visual Studio C++ tools (2022 or 2026), Windows SDK and CMake. Configure `AFTERMATH_SDK_PATH` in local .env, then use the build helper from the project root:

```powershell
.\tools\build-decoder.ps1
```

It finds the installed x64 C++ tools, prefers Visual Studio's bundled CMake, explicitly selects the matching generator and uses `--fresh` to replace a failed generated CMake cache. Visual Studio 2026 needs CMake 4.2 or newer; an older CMake on PATH may not support it. NMake does not accept `-A x64`. This helper avoids that generator mismatch.

For a manual Visual Studio 2022 build:

```powershell
$env:AFTERMATH_SDK_PATH='C:\PrivateTools\NsightAftermathSDK'
cmake --fresh -S native/aftermath-decoder -B native/aftermath-decoder/build -G "Visual Studio 17 2022" -A x64 -DAFTERMATH_SDK_PATH="$env:AFTERMATH_SDK_PATH"
cmake --build native/aftermath-decoder/build --config Release
$env:PATH="$env:AFTERMATH_SDK_PATH\lib\x64;$env:PATH"
.\native\aftermath-decoder\build\Release\aftermath-decoder.exe --version
```

SDK layouts may use `lib` instead of `lib/x64`; CMake checks both. Set local .env `AFTERMATH_DECODER` to the full executable path, `AFTERMATH_SDK_PATH` to the SDK root and optional `AFTERMATH_SHADER_ARTIFACTS` to matching build shader artifacts. The app automatically adds the matching SDK DLL directory to its own process PATH; it does not alter Windows user/system PATH. Direct executable launches outside the app still need the DLL directory on their process PATH.

```powershell
npm run cli -- doctor
npm run cli -- decode --pending
.\native\aftermath-decoder\build\Release\aftermath-decoder.exe --input 'C:\PrivateCrashes\real.nv-gpudmp' --output '.local\probe.json' --shader-artifacts 'C:\PrivateBuilds\shaders'
```

A `--version` probe demonstrates runtime startup only, not actual dump compatibility. Cross-check a real decoded JSON against Nsight Graphics; record SDK/runtime version and real fixture hash before marking M2's live gate complete. Each dump runs in a 60-second subprocess with bounded diagnostics; corrupt input cannot terminate the Node batch. Cache identity includes input hash, executable hash and shader-artifact content fingerprint. Adding artifacts permits re-decode. Decoder exit 2 currently means corrupt **or unsupported** input, without falsely distinguishing unverified SDK error categories. Timeout, missing executable/runtime, partial JSON and successful JSON are separate states. Shader-source coverage stays unverified until raw JSON establishes mappings; unresolved callback counts are retained.

No SDK files are included or redistributed. NVIDIA's guide permits specified runtime libraries subject to the installed SDK LICENSE and third-party terms; packaging them requires reviewing those terms. Use a user-provided SDK by default. No Linux/container decoding compatibility is advertised.

**Build verified 2026-10-03:** the supplied local SDK compiled with Visual Studio 2026/MSVC 19.51 using bundled CMake 4.3.1; the version probe returned `crashlab-decoder/1 SDK API 539`. This confirms compilation/runtime startup, not real dump compatibility. **Pending:** successful real dump decode, real corrupt/unsupported SDK error categorization, resolved shader lookup and Nsight visual comparison. Subprocess failure/timeout isolation is covered using synthetic subprocess tests, not represented as SDK validation.
