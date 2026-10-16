# BLDC motor control for an electric scooter

Interactive page for my part of a five-person project at Mondragon Unibertsitatea (2025-26): measurement boards, motor characterisation, and the current and speed control of a BLDC hub motor on an STM32.

Live: https://perumendibil.github.io/bldc-drive/ · 20-second summary: https://perumendibil.github.io/bldc-drive/video/

## Main page

- `index.html`, `site.css`: the page, drawn as one engineering drawing sheet
- `app.js`: section drawing, charts and the Kp scale; every curve is computed in the browser from `sim.js`
- `scrollcraft.js`, `scrollcraft.css`: scroll engine (pinned views, reveals, parallax)
- `sim.js`: motor and control-loop model with the measured parameters (annex E of the project report)
- `assets/`: images for the main page. `hero-motor.webp`, `winding.webp` and `board-perfboard.webp` are generated images and are labelled as such on the page; `fig-*.webp` are the real scope capture and MATLAB/Simulink figures; `og-card.png` is the link preview

## Kept for /video/ and the studio renders

- `video/index.html`: the 20-second summary page, with `style.css` and `media/teaser.mp4`, `media/teaser-poster.jpg`, `media/video-card.png`
- `charts.js`, `rotor.js`, `style.css` and the PNG figures in `media/`: used by the studio files that render the video and the carousel
- `media/manifest.json`: switches on the pending scooter video (`media/scooter-drive.mp4`) and board photo (`media/boards.jpg`) on the main page

No build step: static HTML, CSS and ES modules.

Peru Mendivil · [LinkedIn](https://www.linkedin.com/in/perumendivil)
