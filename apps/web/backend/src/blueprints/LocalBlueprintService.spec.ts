import { promises as fs } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { LocalBlueprintService } from "./LocalBlueprintService";
import { OsuDBDao } from "./OsuDBDao";
import { BlueprintInfo } from "./BlueprintInfo";

describe("LocalBlueprintService refresh", () => {
  it("keeps disk-only beatmaps out of the DAO cache across repeated scans", async () => {
    const folder = await fs.mkdtemp(join(tmpdir(), "rewind-blueprint-refresh-"));
    try {
      const song = join(folder, "song");
      await fs.mkdir(song);
      await fs.writeFile(
        join(song, "map.osu"),
        [
          "osu file format v14",
          "[General]",
          "AudioFilename: audio.mp3",
          "[Metadata]",
          "Title:Local map",
          "Artist:Artist",
          "Creator:Mapper",
          "Version:Test",
          "[Difficulty]",
          "CircleSize:4",
          "OverallDifficulty:5",
          "[HitObjects]",
        ].join("\n"),
      );
      const cached: BlueprintInfo[] = [
        {
          md5Hash: "cached",
          lastPlayed: new Date(0),
          title: "Database map",
          artist: "Artist",
          creator: "Mapper",
          folderName: "database",
          audioFileName: "audio.mp3",
          osuFileName: "map.osu",
        },
      ];
      const dao = {
        getAllBlueprints: jest.fn().mockResolvedValue(cached),
        getOsuDbLastModifiedTime: jest.fn().mockResolvedValue(0),
      } as unknown as OsuDBDao;
      const service = new LocalBlueprintService(dao, folder);

      const first = await service.completeRead();
      const second = await service.completeRead();

      expect(Object.keys(first)).toHaveLength(2);
      expect(Object.keys(second)).toEqual(Object.keys(first));
      expect(Object.values(second).map((map) => map.title)).toEqual(["Database map", "Local map"]);
      expect(cached).toHaveLength(1);
      expect(cached[0].md5Hash).toBe("cached");
    } finally {
      await fs.unlink(join(folder, "song", "map.osu"));
      await fs.rmdir(join(folder, "song"));
      await fs.rmdir(folder);
    }
  });
});
