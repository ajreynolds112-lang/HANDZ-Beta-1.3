import { fighters, fightResults, type Fighter, type InsertFighter, type FightResult, type InsertFightResult } from "@shared/schema";
import { db } from "./db";
import { eq } from "drizzle-orm";

export interface IStorage {
  getFighters(): Promise<Fighter[]>;
  getFighter(id: string): Promise<Fighter | undefined>;
  createFighter(data: InsertFighter): Promise<Fighter>;
  updateFighter(id: string, data: Partial<InsertFighter>): Promise<Fighter | undefined>;
  deleteFighter(id: string): Promise<void>;
  createFightResult(data: InsertFightResult): Promise<FightResult>;
  getFightResults(fighterId: string): Promise<FightResult[]>;
}

export class DatabaseStorage implements IStorage {
  async getFighters(): Promise<Fighter[]> {
    return db.select().from(fighters);
  }

  async getFighter(id: string): Promise<Fighter | undefined> {
    const [fighter] = await db.select().from(fighters).where(eq(fighters.id, id));
    return fighter;
  }

  async createFighter(data: InsertFighter): Promise<Fighter> {
    // Zod-inferred insert types deep-map nested jsonb props to `unknown`, which
    // drizzle's column types reject structurally — the runtime shape is identical.
    const [fighter] = await db.insert(fighters).values(data as typeof fighters.$inferInsert).returning();
    return fighter;
  }

  async updateFighter(id: string, data: Partial<InsertFighter>): Promise<Fighter | undefined> {
    const [fighter] = await db.update(fighters).set(data as Partial<typeof fighters.$inferInsert>).where(eq(fighters.id, id)).returning();
    return fighter;
  }

  async deleteFighter(id: string): Promise<void> {
    await db.delete(fightResults).where(eq(fightResults.fighterId, id));
    await db.delete(fighters).where(eq(fighters.id, id));
  }

  async createFightResult(data: InsertFightResult): Promise<FightResult> {
    const [result] = await db.insert(fightResults).values(data).returning();
    return result;
  }

  async getFightResults(fighterId: string): Promise<FightResult[]> {
    return db.select().from(fightResults).where(eq(fightResults.fighterId, fighterId));
  }
}

export const storage = new DatabaseStorage();
