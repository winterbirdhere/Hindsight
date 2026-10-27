# Stable score inputs for performance calculation

The score helper uses the actual Stable judgement order. A circle or slider's
final judgement contributes its base score (300, 100, 50 or 0), plus the integer
part of `max(0, comboBefore - 1) * ((baseScore / 25) * difficultyMultiplier * modMultiplier)`.
The implementation preserves the original floating-point multiplication grouping.
Combo changes happen after score calculation. A slider's final judgement does
not change combo. Successful heads, repeats and tails contribute 30, and ticks
contribute 10, without a combo multiplier. A missed tail does not reset combo.
Mod multipliers affect the combo bonus, not the base score.

The official ruleset's ideal legacy score simulator agrees with these components:
[OsuLegacyScoreSimulator](https://github.com/ppy/osu/blob/1032a7c31581513c8be751e46f0940e1c95ed252/osu.Game.Rulesets.Osu/Difficulty/OsuLegacyScoreSimulator.cs#L79-L171).
It is an ideal maximum simulator and cannot reconstruct actual replay scores.
The formula and operation order were checked against the installed Stable
decompilation in `tmp/osu-stable-decompiled`, class
`--z4F19vvh2e-oyzTqnU7231s58ReP0_c2DulTnfP8-.cs`, lines 902–1041,
1216, 1256–1298 and 1329–1330; its multiplier initialization is line 356.

The helper supplies scores for integer difficulty multipliers 0 through 10.
The native engine selects the entry using its own `LegacyScoreBaseMultiplier`.
This retains the official implementation's sensitive decimal approximation of
Stable's x87 arithmetic:
[LegacyRulesetExtensions](https://github.com/ppy/osu/blob/1032a7c31581513c8be751e46f0940e1c95ed252/osu.Game/Rulesets/Objects/Legacy/LegacyRulesetExtensions.cs#L58-L95).
An out-of-range multiplier must use the official fallback, never clamp the table index.

Spinner spin points use the retained Stable scored half-turn count, separately
from its final judgement. For each half-turn `h`, Stable awards 1100 when
`h > required + 3` and `h - required - 3` is even; otherwise it awards 100 when
`h > 1` and `h` is even. These points do not change combo or receive mod scaling.
The priority of these branches matters when the required count is odd.
The helper sums them in constant time and attaches their raw total to the
completed spinner. Since they do not affect combo, this preserves scores even
when other objects overlap the spinner.

The award branch is verified against `OsuLegacyScoreSimulator.cs:102–113,149–155`
at official commit `ebaf7e9910ef3755308dec2c7950d916aabc545b` and the installed
Stable decompilation `--z-1v9bm8APXnxwl9iwaTmyeQohw9HLn5yj8ZfN1c_A1dt.cs`.
Rewind uses actual reconstructed half-turn counts, not the ideal simulator's
maximum rotations. The 17-spinner Touhou 7 replay reproduces all 181,172,351
raw score points without reading its saved score; see `qa/pp-live-timing-20260921`.

The replay omits the original outer update clock, so rotation reconstruction can
still differ from historical playback. Missing or invalid spinner state, Spun
Out's unsupported rotation model, custom rate/DA and other unsupported Stable
score configurations retain the official fallback. Extremely interleaved maps
have a bounded recomputation budget.

When ScoreV1 is unavailable, leave `ScoreInfo.LegacyTotalScore` null to select the
official combo-based effective miss estimate. Rewind does not substitute the
saved header score at the end: simulated counts and score inputs describe the
same reconstructed play throughout. Native lazer and native Classic never inherit a Stable legacy total:
[OsuPerformanceCalculator](https://github.com/ppy/osu/blob/1032a7c31581513c8be751e46f0940e1c95ed252/osu.Game.Rulesets.Osu/Difficulty/OsuPerformanceCalculator.cs#L108-L126).
