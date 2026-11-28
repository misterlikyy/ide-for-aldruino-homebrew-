# Collaboration server

[← Home](../README.md)

> **No public online server is provided.** Run your own server; the default is local-network sharing.

Supports **Ubuntu, Debian, Fedora and Linux Mint**.

## Start here

1. [Download the server ZIP](https://github.com/misterlikyy/Homebrew_IDE/releases/download/latest/IDE-beta-collaboration-server-linux.zip).
2. Extract it and open a terminal in that folder.
3. Run `bash setup-server.sh` and choose **1** for your local network. Wait for **Server is running and responding**.
4. In IDE-beta, choose **Share project → PCs on the same network**. Enter the displayed **Address for all PCs** on the host too, then choose **Check server**.
5. Enter the creation key, share the project, and send an editor/viewer invitation. Guests choose **Join a project** and paste the invitation; they do not need the creation key.

**Next time:** run `bash server.sh` in the extracted folder for a menu. It can check, start, restart or stop the server and show your creation key. Setup saves addresses and a status command in `CONNECT.txt`.

**Already using the older Mint package?** Extract the new server ZIP into your **existing server folder**, replace the packaged files, keep `.env`, and rerun `bash setup-server.sh`. Keep the same folder name and Docker volumes to retain shared projects. The old `setup-mint.sh` command still works.

**Cannot find a script?** Right-click inside the extracted server folder → **Open in Terminal**. For older installations, `sudo docker compose ps` and `sudo docker compose logs --tail=50 collaboration` work from the folder containing `compose.yaml` even without the new menu.

[Full setup, troubleshooting and internet hosting](../source/hosting/linux/README.md) · [Sharing guide](../docs/collaboration.md)

<details>
<summary>Server source and configuration</summary>

- [Hosting scripts and Docker configuration](../source/hosting/linux/)
- [Server runtime](../source/collaboration/server.cjs)

</details>
