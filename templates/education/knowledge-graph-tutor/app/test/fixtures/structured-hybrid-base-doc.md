# Synthetic Concept Mastery Guide: Fractions

This is a fictional regression fixture. It does not reproduce the supplied Large Numbers guide.

```xml
<concept_graph>
  <concept id="C01_Fraction_Foundations">
    <concept_name>Fraction Foundations</concept_name>
    <definition>A fraction names equal parts of a whole.</definition>
    <concept id="C02_Equivalent_Fractions">
      <concept_name>Equivalent Fractions</concept_name>
      <definition>Different names for the same quantity.</definition>
    </concept>
  </concept>
  <concept id="C03_Adding_Fractions">
    <concept_name>Adding Fractions</concept_name>
    <definition>Combine like fractional parts.</definition>
  </concept>
  <dependency from="C01_Fraction_Foundations" to="C02_Equivalent_Fractions" type="prerequisite_of" />
  <dependency from="C02_Equivalent_Fractions" to="C03_Adding_Fractions" type="prerequisite_of" />
</concept_graph>
```

<concept_essay concept_id="C01_Fraction_Foundations"><title>Equal parts</title><content>Each part must have equal size.</content></concept_essay>
<concept_essay concept_id="C01_Fraction_Foundations"><title>Equal parts copy</title><content>Each part must have equal size.</content></concept_essay>

<question_block difficulty="Easy"><concept_id>C01</concept_id><question_text>What does the denominator count?</question_text></question_block><question_block difficulty="Easy"><concept_id>C01_Fraction_Foundations</concept_id><question_text>Shade one half of a rectangle.</question_text></question_block>
<question_block difficulty="Medium"><concept_id>C02_Equivalent_Fractions</concept_id><question_text>Is two fourths equal to one half?</question_text></question_block><question_block difficulty="Medium"><concept_id>C02_Equivalent_Fractions</concept_id><question_text>Find a fraction equal to three sixths.</question_text></question_block>
<question_block difficulty="Difficult"><concept_id>C03_Adding_Fractions</concept_id><question_text>Add one fourth and two fourths.</question_text></question_block><question_block difficulty="Difficult"><concept_id>C03_Adding_Fractions</concept_id><question_text>Explain why common units are needed.</question_text></question_block>

<glossary_term concept_id="C01_Fraction_Foundations"><term>Denominator</term><definition>The number of equal parts in one whole.</definition></glossary_term>

### Card 1
**Front:** What is an equivalent fraction?
**Back:** A fraction naming the same quantity with different numerator and denominator.
