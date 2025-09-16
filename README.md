# WPlace Scripts

A series of scripts I use to download the entire map from WPlace.

Despite what I said on Reddit, I have decided to make the download script public. This is because for it to be effective, you need to spend a reasonable amount of money on proxies, and because I have put no work into making it generalised.

A lot of these scripts contain hardcoded paths. This is because I am lazy. Maybe I will change it to allow CLI arguments in the future, who knows!

## Usage

I'm not helping you out boi. If you don't know how to use these scripts, chances are you're not the kind of person they are meant for.

PNPM for node stuff, whatever the latest Go is for go stuff.

## License

GPLv3. Search it up for the full thing. Basically, you can do whatever you want with this code, no matter what, and you can change and share it with anyone. BUT, if you build upon, modify, or use this code in any way, you must release your changes and all other code under the same license. FOSS FTW.

## Rundown

Some AI used. If it looks like AI, chances are I wrote it. If it looks like a good programmer wrote it, it is probably AI. I do not use AI for code I actually care about. For full transparency, I THINK the ones I wrote are the top-level "main.go", "pull.ts", "extract.ts", and "coords-to-tile.ts" files. Idk about the others, I understand it all obviously, I would be a pre shit programmer if I didn't even try to understand AI generated code. Vibecoders suck.

### pull.ts

Pulls the tiles from WPlace. Uses a shit ton of proxies, with some "smart" logic to use concurrency and not get rate limited.

### extract.ts

Just extracts a series of tiles (given as x, y coords) from a series of 7z archives. I use it to avoid destroying the whole burrito just for a few grains of rice (get some files without extracting the whole thing).

### coords-to-tile.ts

Converts lat/lon coordinates to tile coordinates. And some other conversions. That is all.

### run-pull.ts, wplace.ts, run-pull.ps1, WPlace Pull.xml

The shit that runs the pull script, and some other shit I wanna run like burrito making.

### image-processor.exe, ./main.go

I fucking love Go. I learnt it for this project, and oml it's amazing. Anyway, this is the stuff that does shit like averaging each tile n stuff. Used to be in TS, but it was soooooo slow. Binary is for windows, build it urself if you wanna use it on smth else.

### ./crop/main.go

This one is fun, it takes in a bunch of tiles and crops them "smartly" to a whole bunch of images so I can easily see what kinda art is going on. Also does scaling and stuff so it looks nice when actually viewed because fsr everywhere uses bilinear filtering on tiny images and that makes pixel art look like shit.

## Stuff

I'm a student. I don't know what I'm doing.
