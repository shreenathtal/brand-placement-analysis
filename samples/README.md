# Test clips for obscure-brand / search behavior

Famous brands (Coca-Cola, Pepsi, etc.) often get **`skip search`** from the agent. These samples help you verify **`using search`** for regional or niche brands.

## Option A — Build a local test video (recommended)

Uses ffmpeg only (brand names on screen — no downloads, no copyright issues).

```bash
npm run samples:build
```

Output: `samples/clips/obscure-brands-test.mp4` (~18s, 5 brands: Cheerwine, Moxie, Vernors, Faygo, Sun Drop).

```bash
npm run analyze -- samples/clips/obscure-brands-test.mp4
# or upload in the UI: npm run dev
```

**Expect:** progress log shows `using search` (not `skipping search`) for most of these brands.

## Option B — Your own screen recording

1. Open a few **regional** product pages or short ads (e.g. grocery store brands, local chains).
2. Record 10–20s with QuickTime / OBS.
3. Upload in the UI or pass the file path to `npm run analyze`.

Good categories: regional soda, supermarket own-brand packaging, indie D2C labels, non-US brands you do not sell locally.

## Option C — Download short ads with yt-dlp (optional)

Install [yt-dlp](https://github.com/yt-dlp/yt-dlp). Only download content you have rights to use.

```bash
mkdir -p samples/clips/manual
# Example: first 15 seconds only, 480p or lower
yt-dlp -f "bv*[height<=480]+ba/b[height<=480]" \
  --download-sections "*0:00-0:15" \
  -o "samples/clips/manual/%(title).50s.%(ext)s" \
  "PASTE_VIDEO_URL_HERE"
```

Search ideas on YouTube (short commercials): `Cheerwine commercial`, `Moxie soda ad`, `regional grocery brand ad`, `obscure snack brand commercial`.

## Mixed clip (stress test)

Concatenate your mega-mashup (Coke + obscure) with ffmpeg if you want both behaviors in one run:

```bash
# after you have two mp4 files
printf "file '%s'\nfile '%s'\n" "$(pwd)/samples/clips/obscure-brands-test.mp4" "$(pwd)/your-coke-clip.mp4" > /tmp/list.txt
ffmpeg -f concat -safe 0 -i /tmp/list.txt -c copy samples/clips/mixed-test.mp4
```

Famous brands may still skip search; obscure ones should search.
