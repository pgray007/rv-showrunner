# Local Unraid Testing

## Fastest Path

1. Build and push a test image from your dev machine:

   ```sh
   docker buildx build --platform linux/amd64 -t ghcr.io/YOUR_USER/rv-showrunner:dev --push .
   ```

2. On Unraid, open Docker > Add Container and use:

   - Repository: `ghcr.io/YOUR_USER/rv-showrunner:dev`
   - Web UI port: `3000`
   - `/config` -> `/mnt/user/appdata/rv-showrunner`
   - `/media` -> your Jellyfin media share, read-only
   - `/rv-ready` -> `/mnt/user/rv-ready`
   - `/cache` -> `/mnt/cache/rv-showrunner`
   - Device: `/dev/dri:/dev/dri`
   - Extra parameters: `--device=/dev/dri:/dev/dri --group-add=video --group-add=render`

3. Set environment variables:

   - `JELLYFIN_URL=http://<jellyfin-ip>:8096`
   - `JELLYFIN_API_KEY=<api key>`
   - `JELLYFIN_MEDIA_PATH=<path Jellyfin reports, usually /data/movies or /mnt/user/Media>`
   - `SOURCE_MEDIA_ROOT=/media`
   - `OUTPUT_ROOT=/rv-ready`
   - `CACHE_ROOT=/cache`
   - `CONFIG_ROOT=/config`
   - `HW_ACCEL=vaapi` for Intel iGPU, or `none` for CPU-only testing

4. Open the Web UI and go to Settings.

5. Run:

   - Test Connection
   - Test ffmpeg
   - Unraid Readiness refresh

6. Browse Jellyfin, tag one small movie, and verify:

   - a queued job appears
   - logs stream
   - output lands under `/mnt/user/rv-ready`
   - restart preserves settings and queue state

## Template Testing

After publishing a test image, update `unraid/template.xml` to use that image, then copy it to:

```sh
/boot/config/plugins/dockerMan/templates-user/my-rv-showrunner.xml
```

Then use Docker > Add Container > Template to install from it.

## Pre-Distribution Checks

- Test fresh install with empty `/mnt/user/appdata/rv-showrunner`.
- Test update by changing only the image tag.
- Test with `HW_ACCEL=none` and `HW_ACCEL=vaapi`.
- Confirm the API key is masked in the UI.
- Confirm `/config`, `/cache`, and `/rv-ready` are writable.
- Confirm Jellyfin path mapping points to readable files inside `/media`.
