import ecoledirecte, {
  GradeKind,
  type Period as PawdirectePeriod,
  type GradeValue as PawdirecteGradeValue,
} from "pawdirecte";

import type { EcoleDirecteAccount } from "@/stores/account/types";
import type { Period } from "@/services/shared/Period";
import {
  type AverageOverview,
  type Grade,
  GradeInformation,
  type GradeValue,
} from "@/services/shared/Grade";
import { AttachmentType } from "@/services/shared/Attachment";

const decodePeriod = (p: PawdirectePeriod): Period => {
  return {
    name: p.name,
    id: p.id,
    startTimestamp: p.startDate.getTime(),
    endTimestamp: p.endDate.getTime(),
    yearly: p.yearly,
  };
};

const decodeGradeKind = (kind: GradeKind): GradeInformation | undefined => {
  switch (kind) {
    case GradeKind.Error:
    case GradeKind.Grade:
      return undefined;
    case GradeKind.Absent:
      return GradeInformation.Absent;
    case GradeKind.Exempted:
      return GradeInformation.Exempted;
    case GradeKind.NotGraded:
      return GradeInformation.NotGraded;
    default:
      return undefined;
  }
};

const decodeGradeValue = (
  value: PawdirecteGradeValue | undefined,
): GradeValue => {
  if (!value)
    return {
      disabled: true,
      information: GradeInformation.NotGraded,
      value: 0,
    };

  return {
    disabled: value.kind === GradeKind.Error,
    information: decodeGradeKind(value.kind),
    value: value?.points,
  };
};

const getGradeValue = (value: number | string | undefined): GradeValue => {
  return {
    disabled: false,
    value: value ? Number(value) : 0,
    information: undefined,
  };
};

export const getGradesPeriods = async (
  account: EcoleDirecteAccount,
): Promise<Period[]> => {
  const response = await ecoledirecte.studentGrades(
    account.authentication.session,
    account.authentication.account,
    "",
  );
  return response.periods.map(decodePeriod);
};

export const getGradesAndAverages = async (
  account: EcoleDirecteAccount,
  periodName: string,
): Promise<{
  grades: Grade[];
  averages: AverageOverview;
}> => {
  const period: Period | undefined = (await getGradesPeriods(account)).find(
    (p: Period) => p.name === periodName,
  );

  if (!period) throw new Error("La période sélectionnée n'a pas été trouvée.");

  const response = await ecoledirecte.studentGrades(
    account.authentication.session,
    account.authentication.account,
    "",
  );

  const grades: Grade[] = response.grades
    .filter((g) => g.period.id === period.id && !period.yearly)
    .map((g: ecoledirecte.Grade) => {
      const coefficient = g.coefficient ?? 1;

      const noteValue = g.value?.points ?? 0;
      const outOfValue = g.outOf ? Number(g.outOf) : 20;

      const normalizedNote = outOfValue !== 20
        ? (noteValue / outOfValue) * 20
        : noteValue;

      return {
        id: `${g.subject.name}:${g.date.getTime()}/${g.comment || "none"}`,
        subjectName: g.subject.name,
        description: g.comment,
        timestamp: g.date.getTime(),

        subjectFile: {
          type: AttachmentType.Link,
          name: "Sujet",
          url: g.subjectFilePath,
        },
        correctionFile: {
          type: AttachmentType.Link,
          name: "Corrigé",
          url: g.correctionFilePath,
        },

        isBonus: false,
        isOptional: g.isOptional,

        outOf: getGradeValue(outOfValue),
        coefficient: coefficient,

        student: {
          ...decodeGradeValue(g.value),
          value: noteValue,
          normalizedValue: normalizedNote,
        },
        average: decodeGradeValue(g.average),
        max: decodeGradeValue(g.max),
        min: decodeGradeValue(g.min),
      };
    });

  const subjectAverages: {
    [key: string]: {
      totalWeightedScore: number;
      totalCoefficient: number;
      grades: Grade[];
      classWeightedScore: number;
      classCoefficient: number;
    }
  } = {};

  grades.forEach(grade => {
    const normalizedValue = (grade.student as { normalizedValue?: number }).normalizedValue
      ?? grade.student.value;
    const classValue = grade.average?.value ?? 0;

    if (grade.student.information === undefined
       && !grade.student.disabled
        && normalizedValue !== null
        && normalizedValue !== undefined) {
      const subjectName = grade.subjectName;
      const coefficient = grade.coefficient || 1;

      if (!subjectAverages[subjectName]) {
        subjectAverages[subjectName] = {
          totalWeightedScore: 0,
          totalCoefficient: 0,
          grades: [],
          classWeightedScore: 0,
          classCoefficient: 0
        };
      }

      subjectAverages[subjectName].totalWeightedScore += normalizedValue * coefficient;
      subjectAverages[subjectName].totalCoefficient += coefficient;
      if (grade.average?.value !== undefined && !grade.average.disabled) {
        subjectAverages[subjectName].classWeightedScore += classValue * coefficient;
        subjectAverages[subjectName].classCoefficient += coefficient;
      }
      subjectAverages[subjectName].grades.push(grade);
    }
  });

  const averageSubjects = Object.keys(subjectAverages).map(subjectName => {
    const subjectData = subjectAverages[subjectName];

    const averageValue = subjectData.totalCoefficient > 0
      ? subjectData.totalWeightedScore / subjectData.totalCoefficient
      : 0;

    const classAverageValue = subjectData.classCoefficient > 0
      ? subjectData.classWeightedScore / subjectData.classCoefficient
      : 0;

    const subjectGrades = subjectData.grades;
    const minGrade = subjectGrades.length > 0
      ? Math.min(...subjectGrades.map(g => g.student.value ?? 0))
      : 0;
    const maxGrade = subjectGrades.length > 0
      ? Math.max(...subjectGrades.map(g => g.student.value ?? 0))
      : 0;

    return {
      subjectName,
      average: getGradeValue(averageValue),
      classAverage: getGradeValue(classAverageValue),
      min: getGradeValue(minGrade),
      max: getGradeValue(maxGrade),
      color: "",
      outOf: getGradeValue(20),
      coefficient: 1
    };
  });

  const overallTotalWeightedScore = averageSubjects.reduce(
    (sum, subject) => sum + ((subject.average.value ?? 0) * subject.coefficient),
    0
  );
  const overallTotalCoefficient = averageSubjects.reduce(
    (sum, subject) => sum + subject.coefficient,
    0
  );
  const overallAverage = overallTotalCoefficient > 0
    ? overallTotalWeightedScore / overallTotalCoefficient
    : 0;

  const classOverallTotalWeightedScore = averageSubjects.reduce(
    (sum, subject) => sum + ((subject.classAverage.value ?? 0) * subject.coefficient),
    0
  );
  const classOverallTotalCoefficient = averageSubjects.reduce(
    (sum, subject) => sum + (subject.classAverage.value !== undefined ? subject.coefficient : 0),
    0
  );
  const classOverallAverage = classOverallTotalCoefficient > 0
    ? classOverallTotalWeightedScore / classOverallTotalCoefficient
    : 0;

  const averages: AverageOverview = {
    classOverall: getGradeValue(classOverallAverage),
    overall: getGradeValue(overallAverage),
    subjects: averageSubjects
  };

  return { averages, grades };
};