import numpy as np
import matplotlib.pyplot as plt

# Set up the sphere
phi = np.linspace(0, np.pi, 100)
theta = np.linspace(0, 2*np.pi, 200)
phi, theta = np.meshgrid(phi, theta)

# Unit sphere
x = np.sin(phi) * np.cos(theta)
y = np.sin(phi) * np.sin(theta)
z = np.cos(phi)

fig = plt.figure(figsize=(8, 8))
ax = fig.add_subplot(111, projection="3d")

# Plot sphere surface
ax.plot_surface(x, y, z, rstride=4, cstride=4, linewidth=0, alpha=0.15)

# Fixed number of points
n_points = 40
t = np.linspace(0, 2*np.pi, n_points, endpoint=False)

# Equator (0° latitude) in red dots
x_eq = np.cos(t)
y_eq = np.sin(t)
z_eq = np.zeros_like(t)
ax.scatter(x_eq, y_eq, z_eq, c="red", s=30, marker="x", linewidths=1.5, label="Equator (0°)")

# Higher-latitude circle (60°N) in green dots
lat_deg = 60
lat = np.deg2rad(lat_deg)
r_lat = np.cos(lat)
z_lat = np.sin(lat)
x_lat = r_lat * np.cos(t)
y_lat = r_lat * np.sin(t)
z_lat_line = np.full_like(t, z_lat)
ax.scatter(x_lat, y_lat, z_lat_line, c="green", s=30, marker="x", linewidths=1.5, label=f"~{lat_deg}°N")

# Axis limits and equal aspect
max_range = 1.0
ax.set_xlim([-max_range, max_range])
ax.set_ylim([-max_range, max_range])
ax.set_zlim([-max_range, max_range])
ax.set_box_aspect([1,1,1])

# Clean ticks/labels
ax.set_xticks([])
ax.set_yticks([])
ax.set_zticks([])
ax.set_xlabel("")
ax.set_ylabel("")
ax.set_zlabel("")

# Title and legend
ax.set_title("Dotted Latitude Lines on Globe\nEqual points → denser at smaller circumference")
ax.legend(loc="upper left")

# Save output
out_path = "globe_latitude_dots.png"
plt.savefig(out_path, dpi=200, bbox_inches="tight")
out_path
