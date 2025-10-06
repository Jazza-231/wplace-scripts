# I love ffmpeg but it's just not working for gifs, so using gifski instead
"C:\Users\jazza\Documents\Apps\gifski-1.32.0\win\gifski.exe" --fps 20 --width 20000 --quality 70 -o "../animated.gif" "../*-X*-Y*.png"

# mp4 command, transparent background kept
ffmpeg -framerate 20 -start_number 1 -i "../%d-X431-Y840.png" -vf "pad=ceil(iw/2)*2:ceil(ih/2)*2" -c:v libx265 -pix_fmt yuv420p -x265-params bframes=0 -threads 1 "../animated-t.mp4"

# mp4 command, solid background added
ffmpeg -framerate 20 -start_number 1 -i "../%d-X431-Y840.png" -filter_complex "[0]pad=ceil(iw/2)*2:ceil(ih/2)*2,split=2[bg][fg];[bg]drawbox=c=#9ebdff@1:replace=1:t=fill[bg];[bg][fg]overlay=format=auto" -c:v libx265 -pix_fmt yuv420p -x265-params bframes=0 -threads 1 "../animated-b.mp4"
