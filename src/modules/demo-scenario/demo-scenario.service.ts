import type { Pool, PoolClient } from 'pg';
import type { AuthenticatedDemoSession, DemoSessionService } from '../demo-session/demo-session.service.js';
import { DemoResourceUnavailableError, DemoSessionError } from '../demo-session/demo-session.errors.js';
import { insertScenario, lockScenarioSession, readScenario, requireEmptyScenarioSession, requireGuidedConfiguration,
  type DemoScenarioDto } from './demo-scenario.repository.js';

export interface ScenarioCreateOptions {
  // Test-only transport/barrier seams, never HTTP input or executor calls.
  beforeCommit?: () => Promise<void>;
  commit?: (client: PoolClient) => Promise<void>;
}
export class DemoScenarioService {
  constructor(private readonly db: Pool, private readonly sessions: DemoSessionService,
    private readonly options: ScenarioCreateOptions = {}) {}

  async create(session: AuthenticatedDemoSession): Promise<{ scenario: DemoScenarioDto; created: boolean }> {
    this.sessions.assertTrusted(session);
    const client = await this.db.connect(); let commitSent = false; let discard = false;
    try {
      await client.query('BEGIN');
      await lockScenarioSession(client, session);
      let scenario = await readScenario(client, session.sessionId);
      let created = false;
      if (!scenario) {
        await requireGuidedConfiguration(client);
        await requireEmptyScenarioSession(client, session.companyCode);
        scenario = await insertScenario(client, session.sessionId);
        created = scenario !== null;
        // Explicit unique-conflict recovery; never expose a PostgreSQL 23505.
        scenario ??= await readScenario(client, session.sessionId);
      }
      if (!scenario) throw new Error('Scenario insert did not resolve durable state');
      if (scenario.scenarioType !== 'HAPPY_PATH') {
        throw new DemoSessionError('DEMO_SCENARIO_TYPE_CONFLICT', 409, 'Demo scenario type conflict');
      }
      await this.options.beforeCommit?.();
      commitSent = true;
      if (this.options.commit) await this.options.commit(client); else await client.query('COMMIT');
      return { scenario, created };
    } catch (error) {
      if (commitSent) {
        discard = true;
        // Do not infer rollback. A subsequent Create locks the same session and
        // reads durable state before deciding whether an insert is needed.
        throw new DemoSessionError('DEMO_SCENARIO_CREATE_OUTCOME_UNKNOWN', 503, 'Demo scenario create outcome unavailable; retry creation');
      }
      await client.query('ROLLBACK').catch(() => { discard = true; });
      throw error;
    } finally { client.release(discard); }
  }

  async get(session: AuthenticatedDemoSession, id?: string): Promise<DemoScenarioDto> {
    this.sessions.assertTrusted(session);
    const scenario = await readScenario(this.db, session.sessionId, id);
    if (!scenario) throw new DemoResourceUnavailableError();
    return scenario;
  }

  /** Called INSIDE the existing session queue before any manual domain/fake work.
   * This short admission transaction ends BEFORE calling domain services or an
   * executor. It also waits out an earlier ambiguous Scenario COMMIT. */
  async assertFreeExploration(session: AuthenticatedDemoSession): Promise<void> {
    this.sessions.assertTrusted(session);
    const client = await this.db.connect(); let discard = false;
    try {
      await client.query('BEGIN');
      await lockScenarioSession(client, session);
      if (await readScenario(client, session.sessionId)) {
        throw new DemoSessionError('DEMO_SCENARIO_MODE_CONFLICT', 409, 'Manual operations unavailable in guided scenario mode');
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => { discard = true; }); throw error; }
    finally { client.release(discard); }
  }
}
