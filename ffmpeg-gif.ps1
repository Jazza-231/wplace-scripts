# ffmpeg -y -framerate [FPS] -start_number 1 -i "[input image with %d as number]" -gifflags +offsetting+transdiff -filter_complex "split[s0][s1];[s0]palettegen=stats_mode=single:max_colors=64[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle" -loop 0 "[output.gif]"

ffmpeg -y -framerate 24 -start_number 1 -i "C:\Users\jazza\Downloads\wplace\data\%d-average.png" -gifflags +offsetting+transdiff -filter_complex "split[s0][s1];[s0]palettegen=stats_mode=single:max_colors=64[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle" -loop 0 "C:\Users\jazza\Downloads\wplace\animated.gif"

