# Matter networking

- Matter over Wi-Fi needs no USB radio. Keep the Pi and the device on the same reachable LAN and provide a Matter Server WebSocket endpoint.
- Matter over Thread uses the connected Thread RCP selected in Dinodia OS. The Pi runs OpenThread Border Router on Ethernet, so the Pi is the Border Router for the hub when the Thread radio and OTBR service are healthy.
- The Thread dongle is not a household device and never appears in Devices & entities. It is shown only in Radios & networks.
- A Home Assistant Connect ZBT-1 selected for Zigbee is not shared with Thread. Use a second dedicated Thread adapter for the OTBR profile.
- Do not put Matter fabric credentials, setup codes, Thread datasets, or Wi-Fi credentials in ordinary Dinodia state or support bundles. The commissioning session only exposes the last four setup-code characters.
- If commissioning fails, check LAN multicast, firewall isolation, IPv6, Thread Border Router readiness, and the Matter Server logs. Retry from the Add devices card after correcting the network.
