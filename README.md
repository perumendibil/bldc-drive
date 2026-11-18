# BLDC motor control for an electric scooter

Interactive page for my part of a five-person project at Mondragon Unibertsitatea (2025-26): measurement boards, motor characterisation, and the current and speed control of a BLDC hub motor on an STM32.

Live: https://perumendibil.github.io/bldc-drive/

## Main page

- `index.html`: the whole page in one file (HTML, CSS and JavaScript). The charts are computed in the browser from the motor model; the model code inside it is a literal copy of `sim.js`.
- `sim.js`: motor and control-loop model with the measured parameters (annex E of the project report). It is the single source of the numbers; `studio/check-model.mjs` checks it.
- `assets/`: real material only.
  - `fig-tau-scope.webp`, `fig-kem-scope.jpg`: oscilloscope captures of the τ and K<sub>em</sub> measurements.
  - `fig-bode-filter-matlab.webp`, `fig-current-response.webp`, `fig-speed-response.webp`: MATLAB and Simulink figures.
  - `boards.jpg`, `scooter.jpg`: photos of the measurement boards and of the finished scooter.
  - `og-card.png`: the link preview.

## Kept for the studio renders

- `video/index.html`: the 20-second summary was retired in November 2026; the page now redirects to the main page, so old links keep working.
- `charts.js`, `rotor.js`, `style.css` and the files in `media/`: used by the studio files that rendered the old video and carousel.

No build step: static files.

Peru Mendivil · [LinkedIn](https://www.linkedin.com/in/perumendivil)
