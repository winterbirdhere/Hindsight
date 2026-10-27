import { parseBeatmapBreakPeriods, parseStoryboardSampleEvents } from "./StoryboardSampleInfo";

describe("parseStoryboardSampleEvents", () => {
  it("reads named and numeric sample declarations, variables, layers and volume", () => {
    const result = parseStoryboardSampleEvents(`
[Variables]
$impact=Audio\\impact,wide.ogg
[Events]
// Storyboard Sound Samples
Sample,1200,3,"$impact",72
5,1500,0,"plain.wav"
Sample,1600,2,"pass.mp3",130
Sprite,Foreground,Centre,"ignored.png",320,240
`);

    expect(result).toEqual([
      { time: 1200, layer: 3, filename: "Audio\\impact,wide.ogg", volume: 72 },
      { time: 1500, layer: 0, filename: "plain.wav", volume: 100 },
      { time: 1600, layer: 2, filename: "pass.mp3", volume: 100 },
    ]);
  });
});

describe("parseBeatmapBreakPeriods", () => {
  it("reads named and numeric break declarations while rejecting invalid ranges", () => {
    expect(
      parseBeatmapBreakPeriods(`
[Events]
2,1000,2000
Break,2500,3200
2,4000,3900
Sample,1500,0,"ignored.wav"
`),
    ).toEqual([
      { startTime: 1000, endTime: 2000 },
      { startTime: 2500, endTime: 3200 },
    ]);
  });
});
