// Node-side builder: packages the whole repo into Rideshare-Retroflectivapp.zip.
// Used by the Vite build plugin so the deployed site serves the zip at /Rideshare-Retroflectivapp.zip
import JSZip from "jszip";

export const ZIP_NAME = "Rideshare-Retroflectivapp.zip";

export async function buildZipBuffer() {
  const zip = new JSZip();
  zip.file("PRIVATE-SOURCE-POLICY.txt", "Project source is intentionally not distributed through the public app. Use the private repository / authorized owner workspace for source exports.\n");

  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
