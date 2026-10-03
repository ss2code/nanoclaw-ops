# Synthetic Assessment Bank: Number Patterns

This fictional fixture verifies that authored questions and answer keys drive
student-specific pedagogy and reporting.

```xml
<concept_graph>
  <concept id="N01_Number_Patterns">
    <concept_name>Number Patterns</concept_name>
    <definition>Recognize and extend a rule in a number sequence.</definition>
  </concept>
</concept_graph>
```

<question_block id="pattern-q1" difficulty="Easy" cognitive_level="apply" age_min="13" age_max="14" tags="sequence,diagnostic">
  <concept_id>N01_Number_Patterns</concept_id>
  <question_text>What comes next: 2, 4, 6, __?</question_text>
  <criterion id="answer" weight="0.4"><description>Gives the next number.</description></criterion>
  <criterion id="reasoning" weight="0.6"><description>Explains the constant increase.</description></criterion>
  <acceptable_answer>8 because each term increases by 2.</acceptable_answer>
  <misconception code="repeat-last"><description>Repeats 6 instead of applying the rule.</description><feedback>Compare the gap between each pair.</feedback></misconception>
  <answer>8, because the sequence increases by 2.</answer>
</question_block>

<question_block id="pattern-q2" difficulty="Medium" cognitive_level="analyze" age_min="13" age_max="14" tags="sequence,explanation">
  <concept_id>N01_Number_Patterns</concept_id>
  <question_text>Explain the rule for 3, 6, 12, 24.</question_text>
  <criterion id="rule" weight="1"><description>Identifies and explains the doubling rule.</description></criterion>
</question_block>

<answer question_id="pattern-q2" concept_id="N01_Number_Patterns">
Each term is double the preceding term.
</answer>
