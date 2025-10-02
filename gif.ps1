# I love ffmpeg but it's just not working for gifs, so using gifski instead
"C:\Users\jazza\Documents\Apps\gifski-1.32.0\win\gifski.exe" --fps 20 --width 20000 --quality 70 -o "../animated.gif" "../*-X*-Y*.png"

# mp4 command, transparent background kept
# ffmpeg -framerate 20 -start_number 1 -i "../%d-X557-Y843.png" -c:v libx265 -pix_fmt yuv420p -x265-params "bframes=0" -threads 1 "../animated.mp4"

# mp4 command, solid background added
# ffmpeg -framerate 10 -start_number 1 -i "../%d-X557-Y843.png" -filter_complex "[0:v]format=rgba[fg];color=0x9ebdff[bg];[bg][fg]scale2ref[bg2][fg2];[bg2][fg2]overlay=shortest=1:format=auto" -c:v libx265 -pix_fmt yuv420p -x265-params "bframes=0" -threads 1 "../animated.mp4"
