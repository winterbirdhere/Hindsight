# Third-party license materials

These materials accompany the unmodified NuGet libraries distributed with the
Rewind performance calculator. `package-license-sources.json` records the package
versions, upstream revisions when published by NuGet, copyright notices, source
URLs and SHA-256 hashes. `supplemental-license-sources.json` covers native library
notices, additional license texts and the source archives below. The generated
`../dependency-licenses.json` identifies the files actually shipped.

The official osu! 2026.730.0 libraries use commit
`1032a7c31581513c8be751e46f0940e1c95ed252`; osu!framework 2026.728.1 uses
`21e409540e8a7c9cd6739c05aa6c1e6257bd2b29`. Their original MIT license texts,
including ppy copyright notices, are included here.

SixLabors.ImageSharp 3.1.11 is used under Apache License 2.0 as a transitive
dependency of the official osu! libraries. See `APACHE-2.0.txt` and the retained
package license file for its grant. HidSharpCore 1.3.0 and Remotion.Linq 2.2.0 also
use Apache License 2.0. Remotion.Linq's copyright is
Copyright (c) rubicon IT GmbH, www.rubicon.eu.

## LGPL libraries and corresponding source

TagLibSharp 2.3.0 is licensed under LGPL 2.1. Its complete library source and build
configuration are included in `sources/TagLibSharp-2.3.0-b5ae84f2.zip`, from the
official `TaglibSharp-2.3.0.0` tag, commit
`b5ae84f2e84087bf160bb0471420200dd2b5d809`. Only the `src/TaglibSharp.Tests` directory
of test code and binary media fixtures was omitted from the upstream archive;
all included files are unchanged. The library does not depend on that directory.
Extract the archive and build the library project directly:

```
dotnet build src/TaglibSharp/TaglibSharp.csproj -c Release -f netstandard2.0
```

The four OpenTabletDriver 0.6.7 libraries are licensed under LGPL 3.0 or later.
Their complete unmodified source archive is
`sources/OpenTabletDriver-0.6.7-736003ed.zip`, corresponding to NuGet's published
source revision `736003ed72c8bbb28033b039d5a0bb76c344145c`. The archive includes the
build configuration, library project files, and upstream build documentation.
With .NET 8 installed, build the required library projects, for example:

```
dotnet build OpenTabletDriver/OpenTabletDriver.csproj -c Release
dotnet build OpenTabletDriver.Configurations/OpenTabletDriver.Configurations.csproj -c Release
```

The project references build the associated Plugin and Native libraries. NuGet
restores supply their declared build dependencies. The LGPL license texts and
the GPL 3.0 text incorporated by LGPL 3.0 are included alongside these archives.

The LGPL assemblies remain separate, dynamically loaded DLLs in the performance
engine directory; they are not merged into the executable. Users may modify or
replace these libraries with compatible versions. Reverse engineering for
debugging modifications to these LGPL libraries is permitted. To use a modified
library, close Rewind, retain a backup, replace the corresponding DLL beside
`RewindPerformance.exe`, and restart Rewind. No signature or integrity check
prevents loading a compatible replacement. The application code is separately
licensed; these notices do not change the libraries' licenses.

## Native components

The SDL2, SDL3, stb_image and Veldrid.SPIRV native components have their own
notices here in addition to the managed wrapper licenses. Veldrid.SPIRV's
published source pins its native dependencies in `ext/known_good.json`; the
corresponding license texts and revision list are included. The .NET runtime's
original MIT license and third-party notices are also included.

This calculator excludes the unused osu!framework native-library package; its
FFmpeg and BASS binaries are not part of this distribution.
