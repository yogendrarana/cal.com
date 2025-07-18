import { Prisma } from "@prisma/client";

import db from "@calcom/prisma";

import { type TaskTypes } from "./tasker";
import { scanWorkflowBodySchema } from "./tasks/scanWorkflowBody";

const whereSucceeded: Prisma.TaskWhereInput = {
  succeededAt: { not: null },
};

const whereMaxAttemptsReached: Prisma.TaskWhereInput = {
  attempts: {
    equals: {
      // @ts-expect-error prisma is tripping: '_ref' does not exist in type 'FieldRef<"Task", "Int">'
      _ref: "maxAttempts",
      _container: "Task",
    },
  },
};

/** This is a function to ensure new Date is always fresh */
const makeWhereUpcomingTasks = (): Prisma.TaskWhereInput => ({
  // Get only tasks that have not succeeded yet
  succeededAt: null,
  // Get only tasks that are scheduled to run now or in the past
  scheduledAt: {
    lt: new Date(),
  },
  // Get only tasks where maxAttemps has not been reached
  attempts: {
    lt: {
      // @ts-expect-error prisma is tripping: '_ref' does not exist in type 'FieldRef<"Task", "Int">'
      _ref: "maxAttempts",
      _container: "Task",
    },
  },
});

export class Task {
  static async create(
    type: TaskTypes,
    payload: string,
    options: { scheduledAt?: Date; maxAttempts?: number; referenceUid?: string } = {}
  ) {
    const { scheduledAt, maxAttempts, referenceUid } = options;
    console.info("Creating task", { type, payload, scheduledAt, maxAttempts });
    const newTask = await db.task.create({
      data: {
        payload,
        type,
        scheduledAt,
        maxAttempts,
        referenceUid,
      },
    });
    return newTask.id;
  }

  static async getNextBatch() {
    console.info("Getting next batch of tasks", makeWhereUpcomingTasks());
    return db.task.findMany({
      where: makeWhereUpcomingTasks(),
      orderBy: {
        scheduledAt: "asc",
      },
      take: 1000,
    });
  }

  static async getFailed() {
    return db.task.findMany({
      where: whereMaxAttemptsReached,
    });
  }

  static async getSucceeded() {
    return db.task.findMany({
      where: whereSucceeded,
    });
  }

  static async count() {
    return db.task.count();
  }

  static async countUpcoming() {
    return db.task.count({
      where: makeWhereUpcomingTasks(),
    });
  }

  static async countFailed() {
    return db.task.count({
      where: whereMaxAttemptsReached,
    });
  }

  static async countSucceeded() {
    return db.task.count({
      where: whereSucceeded,
    });
  }

  static async retry({
    taskId,
    lastError,
    minRetryIntervalMins,
  }: {
    taskId: string;
    lastError?: string;
    minRetryIntervalMins?: number | null;
  }) {
    const failedAttemptTime = new Date();
    const updatedScheduledAt = minRetryIntervalMins
      ? new Date(failedAttemptTime.getTime() + 1000 * 60 * minRetryIntervalMins)
      : undefined;

    return db.task.update({
      where: {
        id: taskId,
      },
      data: {
        attempts: { increment: 1 },
        lastError,
        lastFailedAttemptAt: failedAttemptTime,
        ...(updatedScheduledAt && {
          scheduledAt: updatedScheduledAt,
        }),
      },
    });
  }

  static async succeed(taskId: string) {
    return db.task.update({
      where: {
        id: taskId,
      },
      data: {
        attempts: { increment: 1 },
        succeededAt: new Date(),
      },
    });
  }

  static async cancel(taskId: string) {
    return db.task.delete({
      where: {
        id: taskId,
      },
    });
  }

  static async cancelWithReference(referenceUid: string, type: TaskTypes): Promise<{ id: string } | null> {
    // db.task.delete throws an error if the task does not exist, so we catch it and return null
    try {
      return await db.task.delete({
        where: {
          referenceUid_type: {
            referenceUid,
            type,
          },
        },
        select: {
          id: true,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
        // P2025 is the error code for "Record to delete does not exist"
        console.warn(`Task with reference ${referenceUid} and type ${type} does not exist. No action taken.`);
        return null;
      }
      throw error;
    }
  }

  static async cleanup() {
    // TODO: Uncomment this later
    // return db.task.deleteMany({
    //   where: {
    //     OR: [
    //       // Get tasks that have succeeded
    //       whereSucceeded,
    //       // Get tasks where maxAttemps has been reached
    //       whereMaxAttemptsReached,
    //     ],
    //   },
    // });
  }

  static async hasNewerScanTaskForStepId(workflowStepId: number, createdAt: string) {
    const tasks = await db.$queryRaw<{ payload: string }[]>`
      SELECT "payload"
      FROM "Task"
      WHERE "type" = 'scanWorkflowBody'
        AND "succeededAt" IS NULL
        AND (payload::jsonb ->> 'workflowStepId')::int = ${workflowStepId}
        `;

    return tasks.some((task) => {
      try {
        const parsed = scanWorkflowBodySchema.parse(JSON.parse(task.payload));
        if (!parsed.createdAt) return false;
        return new Date(parsed.createdAt) > new Date(createdAt);
      } catch {
        return false;
      }
    });
  }
}
