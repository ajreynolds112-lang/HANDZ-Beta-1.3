/**
 * Side-effect module. `main.tsx` imports this first, ahead of React and the
 * app, because imports evaluate in order: the shipped parameter defaults have
 * to be in localStorage before any config module takes its first read of them.
 */
import { seedTunedDefaults } from "./tuningBundle";

seedTunedDefaults();
