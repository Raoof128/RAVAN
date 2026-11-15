import { BrowserAdapter } from "../../../web/src/player/BrowserAdapter.js";
export class WebOSAdapter extends BrowserAdapter {
  constructor(video: HTMLVideoElement, origin: string) {
    super(video, origin, true);
  }
}
