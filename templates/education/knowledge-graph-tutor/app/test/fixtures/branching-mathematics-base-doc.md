# Synthetic Mastery Guide: Ratio Systems

This fictional fixture exists only for tutor evaluation. It is not derived from the operator's Base_doc.

```xml
<concept_graph>
  <concept id="M01_Whole_Number_Sense"><concept_name>Whole Number Sense</concept_name><definition>Compare and compose whole-number quantities.</definition></concept>
  <concept id="M02_Factors"><concept_name>Factors</concept_name><definition>Numbers that divide a quantity exactly.</definition></concept>
  <concept id="M03_Fractions"><concept_name>Fractions</concept_name><definition>Equal parts of a whole.</definition></concept>
  <concept id="M04_Equivalent_Fractions"><concept_name>Equivalent Fractions</concept_name><definition>Different fraction names for one value.</definition></concept>
  <concept id="M05_Ratio_Language"><concept_name>Ratio Language</concept_name><definition>Multiplicative comparison of two quantities.</definition></concept>
  <concept id="M06_Ratio_Tables"><concept_name>Ratio Tables</concept_name><definition>Equivalent ratios organized in rows.</definition></concept>
  <concept id="M07_Unit_Rates"><concept_name>Unit Rates</concept_name><definition>A rate expressed per one unit.</definition></concept>
  <concept id="M08_Percent"><concept_name>Percent</concept_name><definition>A ratio per one hundred.</definition></concept>
  <concept id="M09_Proportions"><concept_name>Proportions</concept_name><definition>Equations asserting two ratios are equal.</definition></concept>
  <concept id="M10_Scale_Drawings"><concept_name>Scale Drawings</concept_name><definition>Representations using a constant scale factor.</definition></concept>
  <concept id="M11_Multi_Step_Problems"><concept_name>Multi-step Ratio Problems</concept_name><definition>Applications combining rate, percent, and proportion.</definition></concept>
  <concept id="M12_Transfer"><concept_name>Transfer and Explanation</concept_name><definition>Justify ratio reasoning in a new setting.</definition></concept>
  <dependency from="M01_Whole_Number_Sense" to="M02_Factors" type="prerequisite_of" />
  <dependency from="M01_Whole_Number_Sense" to="M03_Fractions" type="prerequisite_of" />
  <dependency from="M03_Fractions" to="M04_Equivalent_Fractions" type="prerequisite_of" />
  <dependency from="M02_Factors" to="M05_Ratio_Language" type="prerequisite_of" />
  <dependency from="M04_Equivalent_Fractions" to="M05_Ratio_Language" type="prerequisite_of" />
  <dependency from="M05_Ratio_Language" to="M06_Ratio_Tables" type="prerequisite_of" />
  <dependency from="M05_Ratio_Language" to="M07_Unit_Rates" type="prerequisite_of" />
  <dependency from="M06_Ratio_Tables" to="M08_Percent" type="prerequisite_of" />
  <dependency from="M07_Unit_Rates" to="M09_Proportions" type="prerequisite_of" />
  <dependency from="M08_Percent" to="M10_Scale_Drawings" type="prerequisite_of" />
  <dependency from="M09_Proportions" to="M10_Scale_Drawings" type="prerequisite_of" />
  <dependency from="M10_Scale_Drawings" to="M11_Multi_Step_Problems" type="prerequisite_of" />
  <dependency from="M08_Percent" to="M11_Multi_Step_Problems" type="prerequisite_of" />
  <dependency from="M11_Multi_Step_Problems" to="M12_Transfer" type="prerequisite_of" />
  <dependency from="M07_Unit_Rates" to="M08_Percent" type="related_to" />
</concept_graph>
```

<concept_essay concept_id="M01_Whole_Number_Sense"><title>Compare quantities</title><content>A quantity can be decomposed and compared using place value.</content></concept_essay>
<concept_essay concept_id="M05_Ratio_Language"><title>Multiplicative comparison</title><content>A ratio compares how many times as much one quantity is as another.</content></concept_essay>
<concept_essay concept_id="M10_Scale_Drawings"><title>Scale factor</title><content>Every corresponding length changes by the same factor.</content></concept_essay>
<concept_essay concept_id="M12_Transfer"><title>Explain a transfer</title><content>A valid transfer names the invariant relationship and checks it in the new context.</content></concept_essay>

<question_block difficulty="Easy"><concept_id>M01_Whole_Number_Sense</concept_id><question_text>Which quantity is larger: 42 or 24?</question_text></question_block>
<question_block difficulty="Medium"><concept_id>M05_Ratio_Language</concept_id><question_text>Describe the ratio of two red counters to three blue counters.</question_text></question_block>
<question_block difficulty="Difficult"><concept_id>M12_Transfer</concept_id><question_text>Explain how a recipe ratio transfers to a scale drawing.</question_text></question_block>
